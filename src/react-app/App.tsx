import { useEffect, useRef, useState } from "react";
import * as AdaptiveCards from "adaptivecards";
import * as ACData from "adaptivecards-templating";
import "adaptivecards/lib/adaptivecards.css";

type CardResponse = {
  card?: unknown;
  error?: string;
  objectKey?: string;
  checkedKeys?: string[];
  availableKeys?: string[];
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDataContext(source: JsonObject): JsonObject {
  const data = source.data ?? source.variables ?? source.$root;

  return isObject(data) ? data : {};
}

function looksLikeAdaptiveCard(value: JsonObject) {
  return value.type === "AdaptiveCard" || "body" in value || "actions" in value;
}

function normalizeAdaptiveCard(value: JsonObject): JsonObject {
  return {
    type: "AdaptiveCard",
    version: "1.5",
    ...value,
  };
}

function findAdaptiveCardPayload(payload: unknown, visited = new Set<unknown>()): unknown {
  if (!isObject(payload) || visited.has(payload)) {
    return undefined;
  }

  visited.add(payload);

  if (looksLikeAdaptiveCard(payload)) {
    return normalizeAdaptiveCard(payload);
  }

  const candidateKeys = [
    "card",
    "adaptiveCard",
    "adaptive_card",
    "template",
    "payload",
    "content",
    "json",
    "value",
  ];

  for (const key of candidateKeys) {
    const candidate = payload[key];
    const card = findAdaptiveCardPayload(candidate, visited);

    if (card) {
      return card;
    }
  }

  for (const value of Object.values(payload)) {
    const card = findAdaptiveCardPayload(value, visited);

    if (card) {
      return card;
    }
  }

  return undefined;
}

function resolveCardPayload(payload: unknown): unknown {
  if (!isObject(payload)) {
    return payload;
  }

  const cardPayload = findAdaptiveCardPayload(payload);
  if (!cardPayload) {
    return payload;
  }

  if (isObject(cardPayload)) {
    const template = new ACData.Template(cardPayload);

    return template.expand({
      $root: getDataContext(payload),
    });
  }

  return cardPayload;
}

function App() {
  const [cardName] = useState("member-payment");
  const [error, setError] = useState<string | null>(null);
  const [objectKey, setObjectKey] = useState<string | null>(null);
  const [renderedCard, setRenderedCard] = useState<HTMLElement | null>(null);
  const cardContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function loadCard() {
      setError(null);
      setObjectKey(null);
      setRenderedCard(null);

      const response = await fetch(`/api/${cardName}`);
      const data = (await response.json()) as CardResponse;
      if (!response.ok) {
        const details = [
          data.checkedKeys?.length ? `Checked: ${data.checkedKeys.join(", ")}` : "",
          data.availableKeys?.length ? `Available: ${data.availableKeys.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" ");

        throw new Error(
          [data.error ?? `Failed to load adaptive card "${cardName}"`, details]
            .filter(Boolean)
            .join(". "),
        );
      }

      const cardPayload = resolveCardPayload(data.card);

      if (!cardPayload) {
        throw new Error(`Adaptive card "${cardName}" did not include a card payload`);
      }

      if (!isObject(cardPayload) || cardPayload.type !== "AdaptiveCard") {
        const keys = isObject(data.card) ? Object.keys(data.card).join(", ") : "";

        throw new Error(
          `Adaptive card "${cardName}" is not an AdaptiveCard payload${
            keys ? `. Top-level keys: ${keys}` : ""
          }`,
        );
      }

      const adaptiveCard = new AdaptiveCards.AdaptiveCard();

      adaptiveCard.parse(cardPayload);

      const validationResults = adaptiveCard.validateProperties();
      if (validationResults.validationEvents.length > 0) {
        const validationMessage = validationResults.validationEvents
          .map((event) => event.message)
          .join("; ");

        throw new Error(`Adaptive card "${cardName}" is invalid: ${validationMessage}`);
      }

      const renderedCard = adaptiveCard.render();
      if (!renderedCard) {
        throw new Error(`Unable to render adaptive card "${cardName}"`);
      }

      if (!renderedCard.textContent?.trim() && renderedCard.children.length === 0) {
        throw new Error(`Adaptive card "${cardName}" rendered with no visible content`);
      }

      setObjectKey(data.objectKey ?? null);
      setRenderedCard(renderedCard);
    }

    loadCard().catch((error: unknown) => {
      setError(error instanceof Error ? error.message : "Failed to load adaptive card");
    });
  }, [cardName]);

  useEffect(() => {
    const container = cardContainerRef.current;

    if (!container) {
      return;
    }

    container.replaceChildren();

    if (renderedCard) {
      container.appendChild(renderedCard);
    }
  }, [renderedCard]);

  return (
    <main>
      <h1>Adaptive Card</h1>
      {objectKey && <p className="source">Loaded from {objectKey}</p>}
      {error && <p role="alert">{error}</p>}
      <div ref={cardContainerRef} id="adaptive-card" />
    </main>
  );
}

export default App;
