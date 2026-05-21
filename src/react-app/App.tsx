import { useEffect, useState } from "react";
import * as AdaptiveCards from "adaptivecards";
import "adaptivecards/lib/adaptivecards.css";

function App() {
  const [cardName] = useState("member-payment");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadCard() {
      const response = await fetch(`/api/${cardName}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? `Failed to load adaptive card "${cardName}"`);
      }

      const adaptiveCard = new AdaptiveCards.AdaptiveCard();

      adaptiveCard.parse(data.card);

      const renderedCard = adaptiveCard.render();
      if (!renderedCard) {
        throw new Error(`Unable to render adaptive card "${cardName}"`);
      }

      const container = document.getElementById("adaptive-card");
      if (container) {
        container.innerHTML = "";
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
      <div id="adaptive-card" />
    </main>
  );
}

export default App;
