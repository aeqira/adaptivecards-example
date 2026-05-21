import { useEffect, useState } from "react";
import * as AdaptiveCards from "adaptivecards";

function App() {
  const [cardName] = useState("member-payment");

  useEffect(() => {
    async function loadCard() {
      const response = await fetch(`/api/${cardName}`);
      const data = await response.json();

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

    loadCard();
  }, [cardName]);

  return (
    <main>
      <h1>Adaptive Card</h1>
      <div id="adaptive-card" />
    </main>
  );
}

export default App;
