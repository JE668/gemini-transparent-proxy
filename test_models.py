import requests
import json
import os

# ================= 配置区 =================
# 你的代理端点
API_BASE = "https://api.170909.xyz/api/v1" 
# 请在此输入你的 Google API Key，或者在运行脚本前设置环境变量 export GOOGLE_API_KEY='your_key'
API_KEY = os.getenv("GOOGLE_API_KEY", "YOUR_API_KEY_HERE")
# =========================================

MODELS_TO_TEST = [
    "gemma-4-31b-it",
    "gemma-4-26b-a4b-it",
    "gemma-3-27b-it",
    "gemma-3-12b-it",
    "gemini-2.5-flash-exp",
    "gemini-2.5-pro-1p-freebie"
]

def test_model(model_id):
    print(f"Testing model: {model_id}...", end=" ", flush=True)
    url = f"{API_BASE}/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": "Hello, are you working?"}],
        "max_tokens": 10
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)
        if response.status_code == 200:
            print("✅ SUCCESS")
            return True
        else:
            print(f"❌ FAILED (Status: {response.status_code})")
            print(f"   Response: {response.text[:200]}")
            return False
    except Exception as e:
        print(f"💥 ERROR: {str(e)}")
        return False

if __name__ == "__main__":
    if API_KEY == "YOUR_API_KEY_HERE":
        print("⚠️  Error: Please set your API key in the script or use 'export GOOGLE_API_KEY=your_key'")
        exit(1)

    print(f"Starting model availability test via {API_BASE}\n" + "="*50)
    results = {}
    for m in MODELS_TO_TEST:
        results[m] = test_model(m)
    
    print("="*50)
    print("\nFinal Summary:")
    for m, res in results.items():
        status = "✅ Available" if res else "❌ Unavailable"
        print(f"{m: <25} : {status}")
