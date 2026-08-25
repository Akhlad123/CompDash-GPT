from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, EmailStr

from app.core.auth import AuthenticatedUser, get_current_user

router = APIRouter(tags=["identity"])


class CurrentUserResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    email: EmailStr | None
    display_name: str | None
    roles: list[str]


@router.get("/me", response_model=CurrentUserResponse)
async def get_me(
    user: Annotated[AuthenticatedUser, Depends(get_current_user)],
) -> CurrentUserResponse:
    return CurrentUserResponse(
        id=str(user.id),
        email=user.email,
        display_name=user.display_name,
        roles=sorted(user.roles),
    )
