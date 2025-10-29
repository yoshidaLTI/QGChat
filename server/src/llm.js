// Ollama 固定アダプタ
import axios from "axios";

const {
  OLLAMA_HOST = "http://localhost:11434",
  OLLAMA_MODEL = "gpt-oss"
} = process.env;

export async function generateLLMReply(messages) {
  const url = `${OLLAMA_HOST.replace(/\/$/, "")}/api/chat`;
  const body = {
    model: OLLAMA_MODEL,
    messages,     // [{role:'system'|'user'|'assistant', content:'...'}]
    stream: false
  };
  const res = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" }
  });
  const content = res.data?.message?.content ?? "";
  return { content };
}

