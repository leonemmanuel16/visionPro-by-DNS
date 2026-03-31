"""Person and Face Recognition routes."""

import asyncio
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


@router.get("/persons/{person_id}", response_model=PersonResponse)
async def get_person(
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

    # Get photo count
    photo_count = 0
    try:
        count_result = await db.execute(
            text("SELECT COUNT(*) FROM face_embeddings WHERE person_id = :pid"),
            {"pid": pid},
        )
        photo_count = count_result.scalar() or 0
    except Exception:
        pass

    return PersonResponse(
        id=str(person.id),
        name=person.name,
        role=person.role,
        department=person.department,
        notes=person.notes,
        is_active=person.is_active,
        photo_count=photo_count,
        created_at=person.created_at,
        updated_at=person.updated_at,
    )


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

    # Compute face encoding in a thread pool to avoid blocking the event loop
    def _compute_embedding(image: np.ndarray):
        """CPU-heavy face detection + encoding — runs in thread pool."""
        try:
            import face_recognition
            rgb = np.ascontiguousarray(image[:, :, ::-1])
            locations = face_recognition.face_locations(rgb, number_of_times_to_upsample=1, model="hog")
            if locations:
                encodings = face_recognition.face_encodings(rgb, known_face_locations=locations)
                if encodings:
                    return encodings[0], True
        except ImportError:
            pass
        except Exception:
            pass
        return None, False

    embedding = None
    face_detected = False
    try:
        embedding, face_detected = await asyncio.to_thread(_compute_embedding, img)
    except Exception:
        pass

    if embedding is not None:
        # Save embedding to pgvector
        emb_str = "[" + ",".join(f"{v:.6f}" for v in embedding) + "]"
        await db.execute(
            text("""
                INSERT INTO face_embeddings (id, person_id, embedding, photo_path, source)
                VALUES (:id, :person_id, CAST(:embedding AS vector), :photo_path, 'upload')
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


@router.delete("/persons/{person_id}/photos/{photo_id}", status_code=204)
async def delete_photo(
    person_id: str,
    photo_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete an individual face embedding/photo."""
    from sqlalchemy import text

    pid = uuid.UUID(person_id)
    phid = uuid.UUID(photo_id)

    result = await db.execute(
        text("SELECT id FROM face_embeddings WHERE id = :photo_id AND person_id = :person_id"),
        {"photo_id": phid, "person_id": pid},
    )
    if not result.first():
        raise HTTPException(status_code=404, detail="Photo not found")

    await db.execute(
        text("DELETE FROM face_embeddings WHERE id = :photo_id AND person_id = :person_id"),
        {"photo_id": phid, "person_id": pid},
    )
    await db.commit()


@router.get("/persons/{person_id}/photos/{photo_id}/image")
async def get_photo_image(
    person_id: str,
    photo_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Serve the photo image of a face embedding from MinIO."""
    from fastapi.responses import Response
    from sqlalchemy import text

    pid = uuid.UUID(person_id)
    phid = uuid.UUID(photo_id)

    result = await db.execute(
        text("SELECT photo_path FROM face_embeddings WHERE id = :photo_id AND person_id = :person_id"),
        {"photo_id": phid, "person_id": pid},
    )
    row = result.first()
    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="Photo not found")

    photo_path = row[0]
    # photo_path format: "bucket/object/path.jpg" e.g. "snapshots/faces/pid/photo.jpg"
    parts = photo_path.split("/", 1)
    if len(parts) != 2:
        raise HTTPException(status_code=404, detail="Invalid photo path")

    bucket, object_name = parts[0], parts[1]
    try:
        minio = get_minio_client()
        data = minio.get_object(bucket, object_name)
        content = data.read()
        data.close()
        data.release_conn()
        return Response(content=content, media_type="image/jpeg")
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Photo not available: {str(e)}")


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
        text("SELECT CAST(embedding AS text), thumbnail_path FROM unknown_faces WHERE id = :fid"),
        {"fid": fid},
    )
    face = row.first()
    if not face:
        raise HTTPException(status_code=404, detail="Unknown face not found")

    # Move embedding to face_embeddings
    new_id = uuid.uuid4()
    await db.execute(
        text("""
            INSERT INTO face_embeddings (id, person_id, embedding, photo_path, source)
            VALUES (:id, :person_id, CAST(:embedding AS vector), :photo_path, 'detection')
        """),
        {
            "id": new_id,
            "person_id": pid,
            "embedding": face[0],
            "photo_path": face[1],
        },
    )

    # Delete from unknown_faces
    await db.execute(text("DELETE FROM unknown_faces WHERE id = :fid"), {"fid": fid})
    await db.commit()

    # Verify the embedding was saved
    verify = await db.execute(
        text("SELECT id FROM face_embeddings WHERE id = :id"),
        {"id": new_id},
    )
    if not verify.first():
        raise HTTPException(status_code=500, detail="Failed to save face embedding")

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


@router.get("/unknown-faces/{face_id}/snapshot")
async def get_unknown_face_snapshot(
    face_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Serve the full snapshot image of an unknown face from MinIO."""
    from fastapi.responses import Response
    from sqlalchemy import text

    fid = uuid.UUID(face_id)
    result = await db.execute(
        text("SELECT thumbnail_path FROM unknown_faces WHERE id = :fid"),
        {"fid": fid},
    )
    row = result.first()
    if not row or not row[0]:
        raise HTTPException(404, "Snapshot not found")

    thumbnail_path = row[0]
    # Derive full snapshot path: abc123.jpg → abc123_full.jpg
    parts = thumbnail_path.split("/", 1)
    if len(parts) != 2:
        raise HTTPException(404, "Invalid path")

    bucket, object_name = parts[0], parts[1]
    full_object = object_name.rsplit(".", 1)[0] + "_full.jpg"

    try:
        minio = get_minio_client()
        data = minio.get_object(bucket, full_object)
        content = data.read()
        data.close()
        data.release_conn()
        return Response(content=content, media_type="image/jpeg")
    except Exception:
        # Fallback to thumbnail if full snapshot not available
        try:
            data = minio.get_object(bucket, object_name)
            content = data.read()
            data.close()
            data.release_conn()
            return Response(content=content, media_type="image/jpeg")
        except Exception as e:
            raise HTTPException(404, f"Snapshot not available: {str(e)}")


@router.post("/events/{event_id}/associate-person")
async def associate_event_to_person(
    event_id: str,
    data: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Extract face from event snapshot and associate it with a person.

    Takes the event snapshot, detects the face, computes the embedding,
    and saves it as a face_embedding for the specified person.
    """
    from sqlalchemy import text
    from fastapi.responses import JSONResponse

    person_id = data.get("person_id")
    if not person_id:
        raise HTTPException(status_code=400, detail="person_id is required")

    eid = uuid.UUID(event_id)
    pid = uuid.UUID(person_id)

    # Verify person exists
    result = await db.execute(select(Person).where(Person.id == pid))
    person = result.scalar_one_or_none()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")

    # Get event snapshot path
    event_row = await db.execute(
        text("SELECT snapshot_path, thumbnail_path, metadata FROM events WHERE id = :eid"),
        {"eid": eid},
    )
    event = event_row.first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    snapshot_path = event[0] or event[1]  # Prefer snapshot, fallback to thumbnail
    if not snapshot_path:
        raise HTTPException(status_code=400, detail="Event has no snapshot image")

    # Load the image from MinIO
    parts = snapshot_path.split("/", 1)
    if len(parts) != 2:
        raise HTTPException(status_code=400, detail="Invalid snapshot path")

    bucket, object_name = parts[0], parts[1]
    try:
        minio = get_minio_client()
        obj = minio.get_object(bucket, object_name)
        img_bytes = obj.read()
        obj.close()
        obj.release_conn()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not load snapshot: {e}")

    # Decode image
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Could not decode snapshot image")

    # Detect face and compute embedding in thread pool (CPU-heavy)
    def _detect_and_embed(image: np.ndarray, raw_bytes: bytes):
        """CPU-heavy face detection — runs in thread pool."""
        emb = None
        crop = None
        try:
            import face_recognition
            rgb = np.ascontiguousarray(image[:, :, ::-1])
            locations = face_recognition.face_locations(rgb, model="hog")
            if not locations:
                locations = face_recognition.face_locations(rgb, number_of_times_to_upsample=2, model="hog")
            if locations:
                encodings = face_recognition.face_encodings(rgb, known_face_locations=locations)
                if encodings:
                    emb = encodings[0]
                    top, right, bottom, left = locations[0]
                    pad = int((bottom - top) * 0.3)
                    h, w = image.shape[:2]
                    top = max(0, top - pad)
                    left = max(0, left - pad)
                    bottom = min(h, bottom + pad)
                    right = min(w, right + pad)
                    face_crop = image[top:bottom, left:right]
                    _, buf = cv2.imencode(".jpg", face_crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
                    crop = buf.tobytes()
        except ImportError:
            crop = raw_bytes
        except Exception:
            crop = raw_bytes
        return emb, crop

    embedding = None
    face_crop_bytes = None
    try:
        embedding, face_crop_bytes = await asyncio.to_thread(_detect_and_embed, img, img_bytes)
    except Exception:
        face_crop_bytes = img_bytes

    # Save face crop to MinIO
    photo_id = str(uuid.uuid4())
    photo_path = f"snapshots/faces/{person_id}/{photo_id}.jpg"
    try:
        save_bytes = face_crop_bytes or img_bytes
        minio = get_minio_client()
        minio.put_object(
            "snapshots",
            f"faces/{person_id}/{photo_id}.jpg",
            io.BytesIO(save_bytes),
            len(save_bytes),
            content_type="image/jpeg",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not save photo: {e}")

    # Save embedding to face_embeddings
    from sqlalchemy import text as sql_text

    new_id = uuid.uuid4()
    if embedding is not None:
        emb_str = "[" + ",".join(f"{v:.6f}" for v in embedding) + "]"
        await db.execute(
            sql_text("""
                INSERT INTO face_embeddings (id, person_id, embedding, photo_path, source)
                VALUES (:id, :person_id, CAST(:embedding AS vector), :photo_path, 'event')
            """),
            {
                "id": new_id,
                "person_id": pid,
                "embedding": emb_str,
                "photo_path": photo_path,
            },
        )
    else:
        await db.execute(
            sql_text("""
                INSERT INTO face_embeddings (id, person_id, photo_path, source)
                VALUES (:id, :person_id, :photo_path, 'event')
            """),
            {
                "id": new_id,
                "person_id": pid,
                "photo_path": photo_path,
            },
        )

    await db.commit()

    msg = f"Rostro del evento asociado a {person.name}"
    if embedding is not None:
        msg += " — embedding calculado para reconocimiento futuro"

    return {
        "message": msg,
        "person_id": str(pid),
        "person_name": person.name,
        "face_detected": embedding is not None,
        "photo_path": photo_path,
    }


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


@router.post("/import-nvr-faces")
async def import_nvr_faces(
    data: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Import face database from Hikvision NVR into our persons table.

    Queries the NVR FDLib, downloads each person's photo, creates a Person
    record, saves the photo to MinIO, and computes face embedding.

    Body: {"ip": "192.168.8.3", "username": "visionpro", "password": "Dns2026."}
    """
    import xml.etree.ElementTree as ET
    import httpx
    from sqlalchemy import text

    nvr_ip = data.get("ip", "")
    nvr_user = data.get("username", "")
    nvr_pass = data.get("password", "")

    if not nvr_ip or not nvr_user or not nvr_pass:
        raise HTTPException(400, "ip, username, and password are required")

    # Step 1: Get face libraries from NVR
    async with httpx.AsyncClient(timeout=15.0) as client:
        auth = httpx.DigestAuth(nvr_user, nvr_pass)

        # Get library list
        resp = await client.get(
            f"http://{nvr_ip}/ISAPI/Intelligent/FDLib", auth=auth
        )
        if resp.status_code != 200:
            raise HTTPException(400, f"Could not query NVR FDLib: {resp.status_code}")

        ns = {"hik": "http://www.hikvision.com/ver20/XMLSchema"}
        root = ET.fromstring(resp.text)
        libs = root.findall(".//hik:FDLibBaseCfg", ns) or root.findall(".//FDLibBaseCfg")

        if not libs:
            return {"message": "No face libraries found on NVR", "imported": []}

        imported = []
        skipped = []

        # Get existing person names to avoid duplicates
        result = await db.execute(select(Person))
        existing_names = {p.name.lower().strip() for p in result.scalars().all()}

        for lib in libs:
            fdid_el = lib.find("hik:FDID", ns) or lib.find("FDID")
            if fdid_el is None or not fdid_el.text:
                continue
            fdid = fdid_el.text

            # Step 2: Search faces in this library
            search_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
            <FDSearchDescription>
                <searchID>{uuid.uuid4().hex[:16]}</searchID>
                <searchResultPosition>0</searchResultPosition>
                <maxResults>200</maxResults>
                <FDID>{fdid}</FDID>
            </FDSearchDescription>'''

            resp = await client.post(
                f"http://{nvr_ip}/ISAPI/Intelligent/FDLib/FDSearch",
                content=search_xml,
                headers={"Content-Type": "application/xml"},
                auth=auth,
            )
            if resp.status_code != 200:
                continue

            search_root = ET.fromstring(resp.text)
            matches = (
                search_root.findall(".//hik:MatchElement", ns)
                or search_root.findall(".//MatchElement")
            )

            for match in matches:
                def _find(tag: str) -> str:
                    el = match.find(f"hik:{tag}", ns)
                    if el is None:
                        el = match.find(tag)
                    return el.text.strip() if el is not None and el.text else ""

                name = _find("name")
                pic_url = _find("picURL")
                pid = _find("PID")
                face_score = _find("faceScore")

                if not name:
                    continue

                # Skip if person already exists
                if name.lower().strip() in existing_names:
                    skipped.append({"name": name, "reason": "already exists"})
                    continue

                # Step 3: Create person in our DB
                person = Person(name=name, role="Empleado", department="")
                db.add(person)
                await db.commit()
                await db.refresh(person)
                person_id = str(person.id)
                existing_names.add(name.lower().strip())

                # Step 4: Download face photo from NVR
                photo_saved = False
                if pic_url:
                    # Fix XML-escaped ampersands
                    pic_url = pic_url.replace("&amp;", "&")
                    try:
                        photo_resp = await client.get(pic_url, auth=auth, timeout=15.0)
                        if photo_resp.status_code == 200 and len(photo_resp.content) > 1000:
                            photo_bytes = photo_resp.content
                            photo_id = str(uuid.uuid4())

                            # Save to MinIO
                            minio = get_minio_client()
                            photo_path = f"faces/{person_id}/{photo_id}.jpg"
                            minio.put_object(
                                "snapshots", photo_path,
                                io.BytesIO(photo_bytes), len(photo_bytes),
                                content_type="image/jpeg",
                            )

                            # Compute face embedding in thread pool
                            nparr = np.frombuffer(photo_bytes, np.uint8)
                            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                            def _compute(image):
                                try:
                                    import face_recognition
                                    rgb = np.ascontiguousarray(image[:, :, ::-1])
                                    locs = face_recognition.face_locations(rgb, model="hog")
                                    if locs:
                                        encs = face_recognition.face_encodings(rgb, locs)
                                        if encs:
                                            return encs[0]
                                except Exception:
                                    pass
                                return None

                            embedding = None
                            if img is not None:
                                embedding = await asyncio.to_thread(_compute, img)

                            # Save embedding to face_embeddings
                            full_path = f"snapshots/{photo_path}"
                            emb_id = uuid.uuid4()
                            if embedding is not None:
                                emb_str = "[" + ",".join(f"{v:.6f}" for v in embedding) + "]"
                                await db.execute(text("""
                                    INSERT INTO face_embeddings (id, person_id, embedding, photo_path, source)
                                    VALUES (:id, :pid, CAST(:emb AS vector), :path, 'nvr_import')
                                """), {"id": emb_id, "pid": person.id, "emb": emb_str, "path": full_path})
                            else:
                                await db.execute(text("""
                                    INSERT INTO face_embeddings (id, person_id, photo_path, source)
                                    VALUES (:id, :pid, :path, 'nvr_import')
                                """), {"id": emb_id, "pid": person.id, "path": full_path})

                            await db.commit()
                            photo_saved = True
                    except Exception as e:
                        pass  # Photo download failed, person still created

                imported.append({
                    "id": person_id,
                    "name": name,
                    "nvr_pid": pid,
                    "face_score": face_score,
                    "photo_saved": photo_saved,
                    "embedding_computed": photo_saved and embedding is not None,
                })

    return {
        "message": f"Imported {len(imported)} persons from NVR ({len(skipped)} skipped)",
        "imported": imported,
        "skipped": skipped,
    }
