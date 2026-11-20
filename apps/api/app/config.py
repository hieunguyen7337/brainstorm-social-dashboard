from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Pulse"
    version: str = "0.1.0"
    database_path: str = "./data/pulse.db"
    web_dist: str = "../mobile/dist"
    public_base_url: str = "http://localhost:8000"

    anthropic_api_key: str = ""
    ai_model: str = "claude-sonnet-5-5"
    ai_workspace_limit: int = 30
    ai_global_cap_usd: float = 60.0

    android_apk_url: str = ""
    autopilot_loop_seconds: int = 60
    trends_ttl_seconds: int = 900


settings = Settings()
