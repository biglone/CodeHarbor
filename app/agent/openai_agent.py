from __future__ import annotations

from openai import AsyncOpenAI

from app.models import ChatMessage


class OpenAIAgent:
    def __init__(self, api_key: str, model: str, system_prompt: str) -> None:
        self._client = AsyncOpenAI(api_key=api_key)
        self._model = model
        self._system_prompt = system_prompt

    async def reply(self, history: list[ChatMessage]) -> str:
        messages: list[dict[str, str]] = [{"role": "system", "content": self._system_prompt}]
        for msg in history:
            messages.append({"role": msg.role, "content": msg.content})

        response = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            temperature=0.2,
        )

        if not response.choices:
            raise RuntimeError("Model returned no choices.")
        content = response.choices[0].message.content
        if not content:
            raise RuntimeError("Model returned an empty message.")
        return content.strip()
