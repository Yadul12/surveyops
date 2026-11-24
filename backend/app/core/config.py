import os
from functools import lru_cache
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    APP_NAME: str = "SurveyOps"
    APP_ENV: str = "development"
    LOG_LEVEL: str = "INFO"

    DATABASE_URL: str = "postgresql+psycopg://surveyops:surveyops_secure_pass@localhost:5472/surveyops"
    POSTGRES_URL: str = ""
    REDIS_URL: str = "redis://localhost:6382/0"
    CELERY_BROKER_URL: str = "redis://localhost:6382/0"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6382/1"
    PIPELINE_EAGER_MODE: bool = False

    SECRET_KEY: str = "surveyops-dev-secret-key-change-in-production-32chars"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 720
    CORS_ORIGINS: str = "http://localhost:3070,http://localhost:5174,http://127.0.0.1:3070,http://127.0.0.1:5174"

    QUALITY_AUTO_APPROVE_THRESHOLD: float = 88.0
    QUALITY_REJECT_THRESHOLD: float = 45.0
    DUPLICATE_WINDOW_MINUTES: int = 60
    MIN_COMPLETION_SECONDS_PER_QUESTION: float = 3.0

    BENCHMARKS_DIR: str = "../benchmarks"

    @property
    def is_vercel(self) -> bool:
        return bool(os.getenv("VERCEL"))

    @property
    def sqlalchemy_database_url(self) -> str:
        raw = (self.DATABASE_URL or "").strip()
        if self.is_vercel and ("localhost:5472" in raw or not raw) and self.POSTGRES_URL:
            raw = self.POSTGRES_URL.strip()
        if raw.startswith("postgres://"):
            return "postgresql+psycopg://" + raw[len("postgres://") :]
        if raw.startswith("postgresql://"):
            return "postgresql+psycopg://" + raw[len("postgresql://") :]
        return raw

    @property
    def effective_redis_url(self) -> str:
        val = (self.REDIS_URL or "").strip()
        if not val or val.lower() in {"none", "disabled", "false"}:
            return ""
        if self.is_vercel and "localhost" in val:
            return ""
        return val

    @property
    def effective_pipeline_eager_mode(self) -> bool:
        return self.PIPELINE_EAGER_MODE or (self.is_vercel and not self.effective_redis_url)

    @property
    def cors_origin_list(self) -> List[str]:
        origins = [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
        for env_key in ("VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"):
            host = (os.getenv(env_key) or "").strip()
            if host:
                origin = host if host.startswith("http") else f"https://{host}"
                if origin not in origins:
                    origins.append(origin)
        return origins


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
