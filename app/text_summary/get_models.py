
import requests
import config.config_manager


def get_models():
    config = config.config_manager.load_config()
    if not config:
        return {"error": "未找到配置文件"}
    
    active_provider = config.get("active_provider", "open-ai")
    provider_config = config.get("providers", {}).get(active_provider, {})
    api_key = provider_config.get("api_key", "")
    api_url = provider_config.get("api_url", "")
    
    if not api_key or not api_url:
        return {"error": "未配置 API Key 或 API URL"}
    
    response = requests.get(
        f"{api_url}/models",
        headers={"Authorization": f"Bearer {api_key}"}
    )
    return response.json()


def get_full_models():
    config = config.config_manager.load_config()
    if not config:
        return {"error": "未找到配置文件"}
    
    active_provider = config.get("active_provider", "open-ai")
    provider_config = config.get("providers", {}).get(active_provider, {})
    api_key = provider_config.get("api_key", "")
    api_url = provider_config.get("api_url", "")
    
    if not api_key or not api_url:
        return {"error": "未配置 API Key 或 API URL"}
    
    response = requests.get(
        f"{api_url}/models/full",
        headers={"Authorization": f"Bearer {api_key}"}
    )
    return response.json()


if __name__ == "__main__":
    models = get_models()
    print("可用模型:", models)

