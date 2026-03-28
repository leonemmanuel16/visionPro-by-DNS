"""Person and Face Recognition routes."""

import io
import uuid
from datetime import datetime, timezone

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import delete, select, func
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from middleware.auth import get_current_user
from models.person import Person, UnknownFace
from models.user import User
from utils.minio_client import get_minio_client, upload_file, get_object_data

router = APIRouter(tags=["persons"])


# --- Schemas ---

class PersonCreate(BaseModel):
    name: str
    role: str | None = None
    department: str | None = None
    notes: str | None = None


class PersonUpdate(BaseModel):
    name: str | None = None
    role: str | None = None
    department: str | None = None
    notes: str | None = None
    is_active: bool | None = None


class PersonResponse(BaseModel):
    id: str
    name: str
    role: str | None
    department: str | None
    notes: str | None
    is_active: bool
    photo_count: int
    created_at: datetime
    updated_at: datetime


class UnknownFaceResponse(BaseModel):
    id: str
    thumbnail_path: str | None
    camera_id: str | None
    first_seen: datetime
    last_seen: datetime
    detection_count: int
    days_remaining: int


# --- Person CRUD ---

@router.get("/persons", response_model=list[PersonResponse])
async def list_persons(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from sqlalchemy import text

    result = await db.execute(select(Person).order_by(Person.name))
    persons = result.scalars().all()

    # Get photo counts in bulk FIRST
    counts: dict[str, int] = {}
    try:
        count_rows = await db.execute(
            text("SELECT person_id, COUNT(*) as cnt FROM face_embeddings GROUP BY person_id")
        )
        counts = {str(row[0]): row[1] for row in count_rows.all()}
    except Exception:
        pass

    response = []
    for p in persons:
        response.append(PersonResponse(
            id=str(p.id),
            name=p.name,
            role=p.role,
            department=p.department,
            notes=p.notes,
            is_active=p.is_active,
            photo_count=counts.get(str(p.id), 0),
            created_at=p.created_at,
            updated_at=p.updated_at,
        ))

    return response


@router.post("/persons", response_model=PersonResponse, status_code=201)
async def create_person(
    data: PersonCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    person = Person(
        name=data.name,
        role=data.role,
        department=data.department,
        notes=data.notes,
    )
    db.add(person)
    await db.commit()
    await db.refresh(person)

    return PersonResponse(
        id=str(person.id),
        name=person.name,
        role=person.role,
        department=person.department,
        notes=person.notes,
        is_active=person.is_active,
        photo_count=0,
        created_at=person.created_at,
        updated_at=person.updated_at,
    )


@router.put("/persons/{person_id}", response_model=PersonResponse)
async def update_person(
    person_id: str,
    data: PersonUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(Person).where(Person.id == uuid.UUID(person_id)))
    person = result.scalar_one_or_none()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(person, key, value)

    await db.commit()
    await db.refresh(person)

    return PersonResponse(
        id=str(person.id),
        name=person.name,
        role=person.role,
        department=person.department,
        notes=person.notes,
        is_active=person.is_active,
        photo_count=0,
        created_at=person.created_at,
        updated_at=person.updated_at,
    )


@router.delete("/persons/{person_id}", status_code=204)
async def delete_person(
    person_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from sqlalchemy import text

    pid = uuid.UUID(person_id)
    result = await db.execute(select(Person).where(Person.id == pid))
    person = result.scalar_one_or_none()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")

    # Delete embeddings first (cascade should handle, but be explicit)
    await db.execute(text("DELETE FROM face_embeddings WHERE person_id = :pid"), {"pid": pid})
    await db.execute(delete(Person).where(Person.id == pid))
    await db.commit()


@router.post("/persons/{person_id}/photos")
async def upload_photo(
    person_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a face photo, compute embedding, save to MinIO + pgvector."""
    from sqlalchemy import text

    pid = uuid.UUID(person_id)
    result = await db.execute(select(Person).where(Person.id == pid))
    person = result.scalar_one_or_none()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")

    # Read image
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Invalid image file")

    # Save photo to MinIO first (always succeeds)
    photo_id = str(uuid.uuid4())
    photo_path = upload_file(
        "snapshots",
        f"faces/{person_id}/{photo_id}.jpg",
        contents,
        "image/jpeg",
    )

    # Try to compute face encoding (may fail if face_recognition not available)
    embedding = None
    face_detected = False
    try:
        import face_recognition
        rgb = np.ascontiguousarray(img[:, :, ::-1])
        locations = face_recognition.face_locations(rgb, number_of_times_to_upsample=1, model="hog")
        if locations:
            encodings = face_recognition.face_encodings(rgb, known_face_locations=locations)
            if encodings:
                embedding = encodings[0]
                face_detected = True
    except ImportError:
        pass  # face_recognition not installed — save photo without embedding
    except Exception as e:
        pass  # face detection failed — save photo anyway

    if embedding is not None:
        # Save embedding to pgvector
        emb_str = "[" + ",".join(f"{v:.6f}" for v in embedding) + "]"
        await db.execute(
            text("""
                INSERT INTO face_embeddings (id, person_id, embedding, photo_path, source)
                VALUES (:id, :person_id, :embedding::vector, :photo_path, 'upload')
            """),
            {
                "id": uuid.uuid4(),
                "person_id": pid,
                "embedding": emb_str,
                "photo_path": photo_path,
            },
        )
    else:
        # Save photo path without embedding (photo stored but no face vector yet)
        await db.execute(
            text("""
                INSERT INTO face_embeddings (id, person_id, photo_path, source)
                VALUES (:id, :person_id, :photo_path, 'upload')
            """),
            {
                "id": uuid.uuid4(),
                "person_id": pid,
                "photo_path": photo_path,
            },
        )

    await db.commit()

    msg = f"Foto subida para {person.name}"
    if face_detected:
        msg += " — rostro detectado y embedding calculado"
    else:
        msg += " — guardada sin embedding (se procesará cuando el detector la analice)"

    return {
        "message": msg,
        "photo_path": photo_path,
        "face_detected": face_detected,
    }


@router.get("/persons/{person_id}/photos")
async def list_photos(
    person_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from sqlalchemy import text

    pid = uuid.UUID(person_id)
    rows = await db.execute(
        text("SELECT id, photo_path, source, created_at FROM face_embeddings WHERE person_id = :pid ORDER BY created_at"),
        {"pid": pid},
    )
    return [
        {
            "id": str(row[0]),
            "photo_path": row[1],
            "source": row[2],
            "created_at": row[3].isoformat() if row[3] else None,
        }
        for row in rows.all()
    ]


# --- Unknown Faces ---

@router.get("/unknown-faces", response_model=list[UnknownFaceResponse])
async def list_unknown_faces(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(UnknownFace)
        .where(UnknownFace.expires_at > now)
        .order_by(UnknownFace.last_seen.desc())
        .limit(100)
    )
    faces = result.scalars().all()

    return [
        UnknownFaceResponse(
            id=str(f.id),
            thumbnail_path=f.thumbnail_path,
            camera_id=str(f.camera_id) if f.camera_id else None,
            first_seen=f.first_seen,
            last_seen=f.last_seen,
            detection_count=f.detection_count,
            days_remaining=max(0, (f.expires_at - now).days),
        )
        for f in faces
    ]


@router.post("/unknown-faces/{face_id}/identify")
async def identify_unknown_face(
    face_id: str,
    data: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Assign an unknown face to a known person."""
    from sqlalchemy import text

    fid = uuid.UUID(face_id)
    person_id = data.get("person_id")
    if not person_id:
        raise HTTPException(status_code=400, detail="person_id is required")

    pid = uuid.UUID(person_id)

    # Get unknown face embedding
    row = await db.execute(
        text("SELECT embedding::text, thumbnail_path FROM unknown_faces WHERE id = :fid"),
        {"fid": fid},
    )
    face = row.first()
    if not face:
        raise HTTPException(status_code=404, detail="Unknown face not found")

    # Move embedding to face_embeddings
    await db.execute(
        text("""
            INSERT INTO face_embeddings (id, person_id, embedding, photo_path, source)
            VALUES (:id, :person_id, :embedding::vector, :photo_path, 'detection')
        """),
        {
            "id": uuid.uuid4(),
            "person_id": pid,
            "embedding": face[0],
            "photo_path": face[1],
        },
    )

    # Delete from unknown_faces
    await db.execute(text("DELETE FROM unknown_faces WHERE id = :fid"), {"fid": fid})
    await db.commit()

    return {"message": "Face identified and assigned to person"}


@router.get("/unknown-faces/{face_id}/thumbnail")
async def get_unknown_face_thumbnail(
    face_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Serve the thumbnail image of an unknown face from MinIO."""
    from fastapi.responses import Response
    from sqlalchemy import text

    fid = uuid.UUID(face_id)
    result = await db.execute(
        text("SELECT thumbnail_path FROM unknown_faces WHERE id = :fid"),
        {"fid": fid},
    )
    row = result.first()
    if not row or not row[0]:
        raise HTTPException(404, "Thumbnail not found")

    thumbnail_path = row[0]
    # thumbnail_path format: "faces/unknown/20260325/abc123.jpg"
    parts = thumbnail_path.split("/", 1)
    if len(parts) != 2:
        raise HTTPException(404, "Invalid thumbnail path")

    bucket, object_name = parts[0], parts[1]
    try:
        minio = get_minio_client()
        data = minio.get_object(bucket, object_name)
        content = data.read()
        data.close()
        data.release_conn()
        return Response(content=content, media_type="image/jpeg")
    except Exception as e:
        raise HTTPException(404, f"Thumbnail not available: {str(e)}")


@router.delete("/unknown-faces/{face_id}", status_code=204)
async def delete_unknown_face(
    face_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete unknown face and move embedding to dismissed list to prevent re-detection."""
    from sqlalchemy import text
    fid = uuid.UUID(face_id)

    # Move embedding to dismissed_faces so detector doesn't re-insert it
    await db.execute(
        text("""
            INSERT INTO dismissed_faces (embedding)
            SELECT embedding FROM unknown_faces WHERE id = :fid
            ON CONFLICT DO NOTHING
        """),
        {"fid": fid},
    )

    # Delete the unknown face
    await db.execute(text("DELETE FROM unknown_faces WHERE id = :fid"), {"fid": fid})
    await db.commit()
