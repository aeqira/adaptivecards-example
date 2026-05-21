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

function resolveCardPayload(payload: unknown): unknown {
  if (!isObject(payload)) {
    return payload;
  }

  if (payload.type === "AdaptiveCard") {
    return payload;
  }

  const wrappedCard = payload.card ?? payload.adaptiveCard ?? payload.template;
  if (!wrappedCard) {
    return payload;
  }

  if (isObject(wrappedCard)) {
    const template = new ACData.Template(wrappedCard);

    return template.expand({
      $root: getDataContext(payload),
    });
  }

  return wrappedCard;
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
        throw new Error(`Adaptive card "${cardName}" is not an AdaptiveCard payload`);
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
