
import json
from pathlib import Path

try:
    from openai import OpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
CONFIG_FILE = PROJECT_ROOT / "config" / "config.json"

def load_config():
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Config] 加载配置失败: {e}")
            return {}
    return {}


def save_config(config):
    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"[Config] 保存配置失败: {e}")
        return False


def get_active_provider_config(config=None):
    if config is None:
        config = load_config()
    active_provider = config.get("active_provider")
    if not active_provider:
        return {}
    return config.get("providers", {}).get(active_provider, {})


def get_provider_config(provider_id, config=None):
    if config is None:
        config = load_config()
    return config.get("providers", {}).get(provider_id)


def get_api_credentials(config=None):
    provider_config = get_active_provider_config(config)
    return (
        provider_config.get("api_url", ""),
        provider_config.get("api_key", ""),
        provider_config.get("default_model", "")
    )


def create_openai_client(config=None):
    if not OPENAI_AVAILABLE:
        return None
    api_url, api_key, _ = get_api_credentials(config)
    if not api_url or not api_key:
        return None
    try:
        return OpenAI(base_url=api_url, api_key=api_key)
    except Exception as e:
        print(f"[Config] OpenAI 客户端创建失败: {e}")
        return None


def is_api_configured(config=None):
    api_url, api_key, _ = get_api_credentials(config)
    return bool(api_url and api_key)

