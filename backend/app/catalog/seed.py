from app.core.config import get_settings
from app.db.session import create_session_factory
from app.services.catalog import seed_catalog


def main() -> None:
    settings = get_settings()
    if not settings.database_url:
        raise RuntimeError("COMPDASH_ASK_DATABASE_URL must be configured before seeding the catalog")
    factory = create_session_factory(settings.database_url)
    with factory() as session:
        seed_catalog(session)


if __name__ == "__main__":
    main()
