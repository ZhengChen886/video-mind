
import json
import requests
from pathlib import Path

try:
    from openai import OpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
CONFIG_FILE = PROJECT_ROOT / "config" / "config.json"

def load_config():
    print(f"[Config] 尝试从 {CONFIG_FILE} 加载配置")
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                config = json.load(f)
            print(f"[Config] 配置加载成功，active_provider: {config.get('active_provider')}")
            print(f"[Config] 已有providers: {list(config.get('providers', {}).keys())}")
            return config
        except Exception as e:
            print(f"[Config] 加载配置失败: {e}")
            return {}
    print(f"[Config] 配置文件不存在，返回空配置")
    return {}


def save_config(config):
    try:
        print(f"[Config] 尝试保存配置到: {CONFIG_FILE}")
        print(f"[Config] 即将保存的配置 - active_provider: {config.get('active_provider')}")
        print(f"[Config] 即将保存的配置 - providers: {list(config.get('providers', {}).keys())}")
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        print(f"[Config] 配置保存成功")
        return True
    except Exception as e:
        print(f"[Config] 保存配置失败: {e}")
        import traceback
        traceback.print_exc()
        return False


def fetch_models_from_api(api_url, api_key, models_url=""):
    """从OpenAI兼容API获取模型列表
    优先使用 models_url；若未提供，则根据 api_url 拼接 /v1/models
    """
    try:
        print(f"[Config] 从API获取模型列表: models_url={models_url}, api_url={api_url}")

        # 优先使用显式传入的 models_url
        if models_url:
            target_url = models_url.strip()
        else:
            # 否则根据 api_url 拼接
            if not api_url:
                return {"success": False, "error": "未提供 models_url 或 api_url"}
            base = api_url.rstrip('/')
            # 如果 api_url 已经包含 /models，直接使用；否则拼接 /v1/models
            if base.endswith('/models'):
                target_url = base
            else:
                if not base.endswith('/v1'):
                    base = base + '/v1'
                target_url = base + '/models'

        print(f"[Config] 实际请求模型列表URL: {target_url}")

        response = requests.get(
            target_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10
        )

        if response.status_code == 200:
            data = response.json()
            models = data.get('data', [])
            print(f"[Config] 成功获取 {len(models)} 个模型")
            # 格式化模型数据
            formatted_models = []
            for model in models:
                formatted_models.append({
                    "id": model.get("id"),
                    "name": model.get("id"),
                    "created": model.get("created", 0),
                    "owned_by": model.get("owned_by", "")
                })
            return {"success": True, "models": formatted_models}
        else:
            print(f"[Config] 获取模型失败: HTTP {response.status_code}")
            return {"success": False, "error": f"HTTP {response.status_code}"}
    except Exception as e:
        print(f"[Config] 获取模型异常: {e}")
        return {"success": False, "error": str(e)}


def save_provider_models(provider_id, models):
    """保存provider的模型列表到配置"""
    config = load_config()
    if 'providers' not in config:
        config['providers'] = {}
    if provider_id not in config['providers']:
        config['providers'][provider_id] = {}
    
    config['providers'][provider_id]['models'] = models
    print(f"[Config] 为provider {provider_id} 保存了 {len(models)} 个模型")
    return save_config(config)


def get_provider_models(provider_id):
    """获取provider已保存的模型列表"""
    config = load_config()
    provider = config.get('providers', {}).get(provider_id, {})
    return provider.get('models', [])


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

