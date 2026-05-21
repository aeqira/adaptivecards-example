import { useEffect, useRef, useState } from "react";
import * as AdaptiveCards from "adaptivecards";
import "adaptivecards/lib/adaptivecards.css";

type CardResponse = {
  card?: unknown;
  error?: string;
};

function App() {
  const [cardName] = useState("member-payment");
  const [error, setError] = useState<string | null>(null);
  const cardContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = cardContainerRef.current;

    async function loadCard() {
      setError(null);
      if (container) {
        container.innerHTML = "";
      }

      const response = await fetch(`/api/${cardName}`);
      const data = (await response.json()) as CardResponse;
      if (!response.ok) {
        throw new Error(data.error ?? `Failed to load adaptive card "${cardName}"`);
      }

      const cardPayload =
        data.card && typeof data.card === "object" && "card" in data.card
          ? data.card.card
          : data.card;

      if (!cardPayload) {
        throw new Error(`Adaptive card "${cardName}" did not include a card payload`);
      }

      const adaptiveCard = new AdaptiveCards.AdaptiveCard();

      adaptiveCard.parse(cardPayload);

      const renderedCard = adaptiveCard.render();
      if (!renderedCard) {
        throw new Error(`Unable to render adaptive card "${cardName}"`);
      }

      if (container) {
        container.appendChild(renderedCard);
      }
    }

    loadCard().catch((error: unknown) => {
      setError(error instanceof Error ? error.message : "Failed to load adaptive card");
    });
  }, [cardName]);

  return (
    <main>
      <h1>Adaptive Card</h1>
      {error && <p role="alert">{error}</p>}
      <div ref={cardContainerRef} id="adaptive-card" />
    </main>
  );
}

export default App;
