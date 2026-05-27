import { useEffect, useRef, useState } from "react";
import * as AdaptiveCards from "adaptivecards";
import "adaptivecards/lib/adaptivecards.css";

type CardResponse = {
  card?: unknown;
  error?: string;
};

type SubmitResponse = {
  error?: string;
  id?: string;
  ok?: boolean;
};

type JsonObject = Record<string, unknown>;
type TargetWidthBucket = "VeryNarrow" | "Narrow" | "Standard" | "Wide";
type CardRoute =
  | {
      apiPath: string;
      cardName: string;
      label: string;
      submitCardName: string;
    }
  | {
      apiPath: string;
      cardName: "payment-details";
      label: string;
      submitCardName: "payment-details";
    };

const targetWidthBreakpoints = {
  narrow: 320,
  standard: 480,
  wide: 1200,
};

const targetWidthOrder: TargetWidthBucket[] = ["VeryNarrow", "Narrow", "Standard", "Wide"];

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
    version: "1.6",
    ...value,
  };
}

function getTargetWidthBucket(width: number): TargetWidthBucket {
  if (width <= targetWidthBreakpoints.narrow) {
    return "VeryNarrow";
  }

  if (width <= targetWidthBreakpoints.standard) {
    return "Narrow";
  }

  if (width <= targetWidthBreakpoints.wide) {
    return "Standard";
  }

  return "Wide";
}

function normalizeTargetWidth(targetWidth: string) {
  const [rawPrefix, rawWidth, ...extraParts] = targetWidth.split(":");

  if (extraParts.length > 0) {
    return null;
  }

  const widthNames: Record<string, TargetWidthBucket> = {
    narrow: "Narrow",
    standard: "Standard",
    verynarrow: "VeryNarrow",
    wide: "Wide",
  };
  const widthName = widthNames[(rawWidth ?? rawPrefix).toLowerCase()];

  if (!widthName) {
    return null;
  }

  if (!rawWidth) {
    return widthName;
  }

  const prefix = rawPrefix.toLowerCase();

  if (prefix === "atleast") {
    return `AtLeast:${widthName}`;
  }

  if (prefix === "atmost") {
    return `AtMost:${widthName}`;
  }

  return null;
}

function targetWidthMatches(targetWidth: string, width: number) {
  const normalizedTargetWidth = normalizeTargetWidth(targetWidth);

  if (!normalizedTargetWidth) {
    return true;
  }

  const bucketIndex = targetWidthOrder.indexOf(getTargetWidthBucket(width));

  if (normalizedTargetWidth.startsWith("AtLeast:")) {
    const targetBucket = normalizedTargetWidth.slice("AtLeast:".length) as TargetWidthBucket;

    return bucketIndex >= targetWidthOrder.indexOf(targetBucket);
  }

  if (normalizedTargetWidth.startsWith("AtMost:")) {
    const targetBucket = normalizedTargetWidth.slice("AtMost:".length) as TargetWidthBucket;

    return bucketIndex <= targetWidthOrder.indexOf(targetBucket);
  }

  return normalizedTargetWidth === getTargetWidthBucket(width);
}

function applyScreenSizeConstraints(value: unknown, width: number): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => applyScreenSizeConstraints(item, width))
      .filter((item) => item !== null);
  }

  if (!isObject(value)) {
    return value;
  }

  if (
    typeof value.targetWidth === "string" &&
    !targetWidthMatches(value.targetWidth, width)
  ) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "targetWidth")
      .map(([key, childValue]) => [key, applyScreenSizeConstraints(childValue, width)])
      .filter(([, childValue]) => childValue !== null),
  );
}

function getCardRouteFromUrl(): CardRoute {
  const url = new URL(window.location.href);
  const lookupId = url.searchParams.get("lookup");

  if (lookupId) {
    return {
      apiPath: `/api/lookup/${encodeURIComponent(lookupId)}`,
      cardName: "payment-details",
      label: `payment-details for ${lookupId}`,
      submitCardName: "payment-details",
    };
  }

  const queryCardName =
    url.searchParams.get("card") ?? url.searchParams.get("q") ?? url.searchParams.get("name");

  if (queryCardName) {
    return {
      apiPath: `/api/${encodeURIComponent(queryCardName)}`,
      cardName: queryCardName,
      label: queryCardName,
      submitCardName: queryCardName,
    };
  }

  const pathSegments = url.pathname
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== "api");

  if (pathSegments[0] === "lookup" && pathSegments[1]) {
    const submissionId = pathSegments[1];

    return {
      apiPath: `/api/lookup/${encodeURIComponent(submissionId)}`,
      cardName: "payment-details",
      label: `payment-details for ${submissionId}`,
      submitCardName: "payment-details",
    };
  }

  const pathCardName = pathSegments[pathSegments.length - 1];
  const cardName = pathCardName ?? "member-payment";

  return {
    apiPath: `/api/${encodeURIComponent(cardName)}`,
    cardName,
    label: cardName,
    submitCardName: cardName,
  };
}

function App() {
  const [cardRoute] = useState(getCardRouteFromUrl);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [layoutWidth, setLayoutWidth] = useState(window.innerWidth);
  const [renderedCard, setRenderedCard] = useState<HTMLElement | null>(null);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const cardContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = cardContainerRef.current;

    function updateLayoutWidth() {
      setLayoutWidth(container?.clientWidth ?? window.innerWidth);
    }

    updateLayoutWidth();

    if (!container || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateLayoutWidth);

      return () => window.removeEventListener("resize", updateLayoutWidth);
    }

    const observer = new ResizeObserver(updateLayoutWidth);
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    async function loadCard() {
      setError(null);
      setIsLoading(true);
      setRenderedCard(null);
      setSubmitMessage(null);

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(cardRoute.apiPath, {
        signal: controller.signal,
      });
      window.clearTimeout(timeout);

      const data = (await response.json()) as CardResponse;
      if (!response.ok) {
        throw new Error(data.error ?? `Failed to load adaptive card "${cardRoute.cardName}"`);
      }

      const cardPayload = normalizeCardPayload(data.card);
      if (!cardPayload) {
        throw new Error(`Adaptive card "${cardRoute.cardName}" is not an AdaptiveCard payload`);
      }

      const adaptiveCard = new AdaptiveCards.AdaptiveCard();
      const constrainedCardPayload = applyScreenSizeConstraints(cardPayload, layoutWidth);

      adaptiveCard.onExecuteAction = (action) => {
        if (!(action instanceof AdaptiveCards.SubmitAction)) {
          return;
        }

        const submission = action.data;
        setSubmitMessage("Submitting...");

        fetch(`/api/${encodeURIComponent(cardRoute.submitCardName)}/submissions`, {
          body: JSON.stringify({
            data: submission,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        })
          .then(async (response) => {
            const result = (await response.json()) as SubmitResponse;

            if (!response.ok) {
              throw new Error(result.error ?? "Failed to submit card data");
            }

            setSubmitMessage(result.id ? `Submitted ${result.id}` : "Submitted");
          })
          .catch((error: unknown) => {
            setSubmitMessage(null);
            setError(error instanceof Error ? error.message : "Failed to submit card data");
          });
      };

      adaptiveCard.parse(constrainedCardPayload);

      const validationResults = adaptiveCard.validateProperties();
      if (validationResults.validationEvents.length > 0) {
        const validationMessage = validationResults.validationEvents
          .map((event) => event.message)
          .join("; ");

        throw new Error(`Adaptive card "${cardRoute.cardName}" is invalid: ${validationMessage}`);
      }

      const renderedCard = adaptiveCard.render();
      if (!renderedCard) {
        throw new Error(`Unable to render adaptive card "${cardRoute.cardName}"`);
      }

      if (!renderedCard.textContent?.trim() && renderedCard.children.length === 0) {
        throw new Error(`Adaptive card "${cardRoute.cardName}" rendered with no visible content`);
      }

      setRenderedCard(renderedCard);
      setIsLoading(false);
    }

    loadCard().catch((error: unknown) => {
      setIsLoading(false);
      if (error instanceof DOMException && error.name === "AbortError") {
        setError("Timed out loading the adaptive card API");
        return;
      }

      setError(error instanceof Error ? error.message : "Failed to load adaptive card");
    });
  }, [cardRoute, layoutWidth]);

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
      <p className="source">Search term: {cardRoute.label}</p>
      {isLoading && <p className="source">Loading card...</p>}
      {submitMessage && <p className="source">{submitMessage}</p>}
      {error && <p role="alert">{error}</p>}
      <div ref={cardContainerRef} id="adaptive-card" />
    </main>
  );
}

export default App;
