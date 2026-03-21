"""MinIO S3-compatible object storage client."""

from io import BytesIO

from minio import Minio

from config import settings

_client: Minio | None = None

BUCKETS = ["snapshots", "clips", "thumbnails"]


def get_minio_client() -> Minio:
    global _client
    if _client is None:
        _client = Minio(
            settings.MINIO_ENDPOINT,
            access_key=settings.MINIO_ACCESS_KEY,
            secret_key=settings.MINIO_SECRET_KEY,
            secure=False,
        )
    return _client


def ensure_buckets() -> None:
    client = get_minio_client()
    for bucket in BUCKETS:
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)


def upload_file(
    bucket: str, object_name: str, data: bytes, content_type: str = "application/octet-stream"
) -> str:
    client = get_minio_client()
    client.put_object(
        bucket,
        object_name,
        BytesIO(data),
        length=len(data),
        content_type=content_type,
    )
    return f"{bucket}/{object_name}"


def get_object_data(bucket: str, object_name: str) -> bytes:
    """Download object data as bytes (for email attachments)."""
    client = get_minio_client()
    response = client.get_object(bucket, object_name)
    try:
        return response.read()
    finally:
        response.close()
        response.release_conn()


def get_presigned_url(bucket: str, object_name: str, expires: int = 3600) -> str:
    from datetime import timedelta

    client = get_minio_client()
    return client.presigned_get_object(bucket, object_name, expires=timedelta(seconds=expires))
