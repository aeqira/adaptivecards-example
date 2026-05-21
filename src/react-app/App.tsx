import { useEffect, useRef, useState } from "react";
import * as AdaptiveCards from "adaptivecards";
import "adaptivecards/lib/adaptivecards.css";

type CardResponse = {
  card?: unknown;
  error?: string;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeAdaptiveCard(value: JsonObject) {
  return value.type === "AdaptiveCard" || "body" in value || "actions" in value;
}

function normalizeCardPayload(value: unknown): JsonObject | null {
  if (!isObject(value) || !looksLikeAdaptiveCard(value)) {
    return null;
  }

  return {
    type: "AdaptiveCard",
    version: "1.5",
    ...value,
  };
}

function getCardNameFromUrl() {
  const url = new URL(window.location.href);
  const queryCardName =
    url.searchParams.get("card") ?? url.searchParams.get("q") ?? url.searchParams.get("name");

  if (queryCardName) {
    return queryCardName;
  }

  const pathSegments = url.pathname
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== "api");
  const pathCardName = pathSegments[pathSegments.length - 1];

  return pathCardName ?? "member-payment";
}

function App() {
  const [cardName] = useState(getCardNameFromUrl);
  const [error, setError] = useState<string | null>(null);
  const [renderedCard, setRenderedCard] = useState<HTMLElement | null>(null);
  const cardContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function loadCard() {
      setError(null);
      setRenderedCard(null);

      const response = await fetch(`/api/${encodeURIComponent(cardName)}`);
      const data = (await response.json()) as CardResponse;
      if (!response.ok) {
        throw new Error(data.error ?? `Failed to load adaptive card "${cardName}"`);
      }

      const cardPayload = normalizeCardPayload(data.card);
      if (!cardPayload) {
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
      <p className="source">Search term: {cardName}</p>
      {error && <p role="alert">{error}</p>}
      <div ref={cardContainerRef} id="adaptive-card" />
    </main>
  );
}

export default App;
