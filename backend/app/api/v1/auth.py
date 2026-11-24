from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user, require_roles
from app.core.security import create_access_token, hash_password, verify_password
from app.db.base import utcnow
from app.db.session import get_db
from app.models.models import AuditEvent, Role, User
from app.schemas.schemas import LoginRequest, LoginResponse, UserCreateRequest, UserSummary

router = APIRouter(prefix="/auth", tags=["Authentication & Users"])


def _serialize_user(user: User) -> UserSummary:
    return UserSummary(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role.name if user.role else "field_agent",
        permissions=list(user.role.permissions) if user.role and user.role.permissions else [],
        department=user.department,
        region=user.region,
        is_active=user.is_active,
        last_login_at=user.last_login_at,
    )


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.execute(
        select(User).options(selectinload(User.role)).where(User.email == payload.email.lower().strip())
    ).scalar_one_or_none()

    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password.")

    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is deactivated.")

    user.last_login_at = utcnow()
    db.add(
        AuditEvent(
            entity_type="user",
            entity_id=str(user.id),
            action="user.login",
            actor_id=user.id,
            actor_type="user",
            summary=f"{user.full_name} ({user.role.name}) signed in.",
            notify_level="none",
        )
    )
    db.commit()

    token = create_access_token(subject=str(user.id), role=user.role.name)
    return LoginResponse(access_token=token, user=_serialize_user(user))


@router.get("/me", response_model=UserSummary)
def get_me(current_user: User = Depends(get_current_user)):
    return _serialize_user(current_user)


@router.get("/users", response_model=List[UserSummary])
def list_users(
    role: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin", "analyst")),
):
    stmt = select(User).options(selectinload(User.role)).order_by(User.full_name.asc())
    if role:
        stmt = stmt.join(Role, User.role_id == Role.id).where(Role.name == role)
    if search:
        term = f"%{search.strip()}%"
        stmt = stmt.where((User.full_name.ilike(term)) | (User.email.ilike(term)) | (User.region.ilike(term)))
    users = db.execute(stmt).scalars().all()
    return [_serialize_user(u) for u in users]


@router.post("/users", response_model=UserSummary, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin")),
):
    email_norm = payload.email.lower().strip()
    existing = db.execute(select(User).where(User.email == email_norm)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="A user with this email already exists.")

    role_obj = db.execute(select(Role).where(Role.name == payload.role_name)).scalar_one_or_none()
    if not role_obj:
        raise HTTPException(status_code=400, detail=f"Unknown role '{payload.role_name}'.")

    user = User(
        email=email_norm,
        full_name=payload.full_name.strip(),
        hashed_password=hash_password(payload.password),
        role_id=role_obj.id,
        department=payload.department,
        region=payload.region,
    )
    db.add(user)
    db.flush()
    db.add(
        AuditEvent(
            entity_type="user",
            entity_id=str(user.id),
            action="user.created",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Created {payload.role_name} account for {user.full_name} ({user.email}).",
            notify_level="info",
        )
    )
    db.commit()
    db.refresh(user)
    user.role = role_obj
    return _serialize_user(user)
