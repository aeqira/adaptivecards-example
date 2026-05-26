import { useEffect, useRef, useState } from "react";
import * as AdaptiveCards from "adaptivecards";
import "adaptivecards/lib/adaptivecards.css";

type CardResponse = {
  card?: unknown;
  error?: string;
};

type JsonObject = Record<string, unknown>;

const targetWidthClassNames: Record<string, string> = {
  "AtLeast:Narrow": "ac-target-at-least-narrow",
  "AtLeast:Standard": "ac-target-at-least-standard",
  "AtLeast:Wide": "ac-target-at-least-wide",
  "AtMost:Narrow": "ac-target-at-most-narrow",
  "AtMost:Standard": "ac-target-at-most-standard",
  "AtMost:Wide": "ac-target-at-most-wide",
  Narrow: "ac-target-narrow",
  Standard: "ac-target-standard",
  VeryNarrow: "ac-target-very-narrow",
  Wide: "ac-target-wide",
};

const targetWidthBreakpoints = {
  narrow: 320,
  standard: 480,
  wide: 1200,
};

const targetWidthOrder = ["VeryNarrow", "Narrow", "Standard", "Wide"] as const;

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

function applySizingFix(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(applySizingFix)
      .filter((item) => item !== null);
  }

  if (!isObject(value)) {
    return value;
  }

  const fixedValue = Object.fromEntries(
    Object.entries(value).map(([key, childValue]) => [key, applySizingFix(childValue)]),
  );

  if (typeof fixedValue.targetWidth === "string") {
    const normalizedTargetWidth = normalizeTargetWidth(fixedValue.targetWidth);
    const className = normalizedTargetWidth
      ? targetWidthClassNames[normalizedTargetWidth]
      : undefined;

    if (className && typeof fixedValue.customCssSelector !== "string") {
      fixedValue.customCssSelector = className;
    }
  }

  return fixedValue;
}

function getTargetWidthBucket(width: number) {
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

  const widthNames: Record<string, string> = {
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

  const bucket = getTargetWidthBucket(width);
  const bucketIndex = targetWidthOrder.indexOf(bucket);

  if (normalizedTargetWidth.startsWith("AtLeast:")) {
    return (
      bucketIndex >=
      targetWidthOrder.indexOf(
        normalizedTargetWidth.slice("AtLeast:".length) as (typeof targetWidthOrder)[number],
      )
    );
  }

  if (normalizedTargetWidth.startsWith("AtMost:")) {
    return (
      bucketIndex <=
      targetWidthOrder.indexOf(
        normalizedTargetWidth.slice("AtMost:".length) as (typeof targetWidthOrder)[number],
      )
    );
  }

  return normalizedTargetWidth === bucket;
}

function filterTargetWidths(value: unknown, width: number): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => filterTargetWidths(item, width))
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

  const filteredValue = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "targetWidth")
      .map(([key, childValue]) => [key, filterTargetWidths(childValue, width)])
      .filter(([, childValue]) => childValue !== null),
  );

  return filteredValue;
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
  const [isLoading, setIsLoading] = useState(true);
  const [layoutWidth, setLayoutWidth] = useState(window.innerWidth);
  const [renderedCard, setRenderedCard] = useState<HTMLElement | null>(null);
  const cardContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function updateLayoutWidth() {
      setLayoutWidth(cardContainerRef.current?.clientWidth ?? window.innerWidth);
    }

    updateLayoutWidth();
    window.addEventListener("resize", updateLayoutWidth);

    return () => window.removeEventListener("resize", updateLayoutWidth);
  }, []);

  useEffect(() => {
    async function loadCard() {
      setError(null);
      setIsLoading(true);
      setRenderedCard(null);

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(`/api/${encodeURIComponent(cardName)}`, {
        signal: controller.signal,
      });
      window.clearTimeout(timeout);

      const data = (await response.json()) as CardResponse;
      if (!response.ok) {
        throw new Error(data.error ?? `Failed to load adaptive card "${cardName}"`);
      }

      const cardPayload = normalizeCardPayload(data.card);
      if (!cardPayload) {
        throw new Error(`Adaptive card "${cardName}" is not an AdaptiveCard payload`);
      }

      const adaptiveCard = new AdaptiveCards.AdaptiveCard();
      const sizedCardPayload = filterTargetWidths(cardPayload, layoutWidth);

      adaptiveCard.parse(applySizingFix(sizedCardPayload));

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
  }, [cardName, layoutWidth]);

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
      {isLoading && <p className="source">Loading card...</p>}
      {error && <p role="alert">{error}</p>}
      <div ref={cardContainerRef} id="adaptive-card" />
    </main>
  );
}

export default App;
