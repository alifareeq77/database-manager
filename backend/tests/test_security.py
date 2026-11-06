from app.core.security import decrypt_secret, encrypt_secret, hash_password, verify_password


def test_password_hashing():
    h = hash_password("s3cret-password")
    assert h.startswith("scrypt$") and "s3cret" not in h
    assert verify_password("s3cret-password", h)
    assert not verify_password("wrong", h)
    assert not verify_password("x", "garbage")


def test_secret_encryption_roundtrip():
    token = encrypt_secret("db-pass")
    assert token and "db-pass" not in token
    assert decrypt_secret(token) == "db-pass"
    assert encrypt_secret(None) is None and decrypt_secret(None) is None
