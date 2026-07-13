class SidukoPlayerData {
  #guessesRemaining;
  #funds;
  #boosts;
  #puzzle;
  constructor() {
    this.#guessesRemaining = 0;
    this.#funds = 0;
    this.#boosts = [];
    this.#puzzle = null;
  }

  get guessesRemaining() {
    return this.#guessesRemaining;
  }

  set guessesRemaining(value) {
    this.#guessesRemaining = value;
    const oElem = document.getElementById("playerGuessesRemaining");
    if (oElem) {
      // TODO:: animate
      oElem.innerText = value;
    }
  }

  get funds() {
    return this.#funds;
  }

  set funds(value) {
    const oElem = document.getElementById("playerFunds");
    if (oElem) {
      oElem.innerText = "$" + value;

      if (value > this.funds) {
        oElem.classList.add("fund-boost");
        const fnListener = () => {
          const playerFundsElem = document.getElementById("playerFunds");
          playerFundsElem.classList.remove("fund-boost");
          playerFundsElem.removeEventListener("animationend", fnListener);
        };
        oElem.addEventListener("animationend", fnListener);
      } else if (value < this.funds) {
        oElem.classList.add("fund-reduce");
        const fnListener = () => {
          const playerFundsElem = document.getElementById("playerFunds");
          playerFundsElem.classList.remove("fund-reduce");
          playerFundsElem.removeEventListener("animationend", fnListener);
        };
        oElem.addEventListener("animationend", fnListener);
      }
    }

    this.#funds = value;
  }

  get boosts() {
    return this.#boosts;
  }

  set puzzle(value) {
    this.#puzzle = value;
  }

  get puzzle() {
    return this.#puzzle;
  }
  
  // returns a reference to a newly added boost, or an existing item
  // if one with the same name already exists
  addBoost(boostName, boosDescription, puzzle) {
    const existingBoost = this.#boosts.find((b) => b.name === boostName);
    if (existingBoost) {
      return existingBoost;
    }
    const boost = new SidukoBoostData(boostName, boosDescription, puzzle);
    this.#boosts.push(boost);
    return boost;
  }

  addBoostItem(boost) {
    const existingBoost = this.#boosts.find((b) => b.name === boost.name);
    if (existingBoost) {
      return existingBoost;
    }
    this.#boosts.push(boost);
    return boost;
  }

  getBoost(boostName) {
    return this.#boosts.find((b) => b.name === boostName);
  }

  deleteBoost(boostName) {
    const index = this.#boosts.findIndex((b) => b.name === boostName);
    if (index > -1) {
      this.#boosts.splice(index, 1);
    }
  }

  __sortBoosts() {
    const aBoosts = [...this.#boosts];
    this.#boosts.sort((oBoost1, oBoost2) => {
      if (oBoost1.getCanUse() && !oBoost2.getCanUse()) {
        return -1;
      } else if (oBoost2.getCanUse() && !oBoost1.getCanUse()) {
        return 1;
      }
      if (oBoost1.turnsRemaining > oBoost2.turnsRemaining) {
        return -1;
      } else if (oBoost1.turnsRemaining < oBoost2.turnsRemaining) {
        return 1;
      }
      if (oBoost1.maxCellCount > oBoost2.maxCellCount) {
        return -1;
      } else if (oBoost1.maxCellCount < oBoost2.maxCellCount) {
        return 1;
      }
      oBoost1.name.localeCompare(oBoost2.name);
    });
    this.#boosts = aBoosts;
  }

  __getBonusButtonDom(boost) {
    const boostButton = document.createElement("div");
    boostButton.classList.add("boost_button");

    const glyphDiv = document.createElement("div");
    glyphDiv.classList.add("boost_glyph");
    glyphDiv.innerText = boost.glyph;
    if (boost.boostable) {
      const sPrefix = `Reveals up to ${boost.maxCellCount} cells `
      glyphDiv.title = sPrefix + boost.description;
    } else {
      glyphDiv.title = `${boost.description}`;
    }
    glyphDiv.dataset.boostName = boost.name;

    boostButton.appendChild(glyphDiv);
    return boostButton;
  }

  renderBoosts() {
    this.__sortBoosts();
    const availableBoostsElement = document.getElementById("availableBoosts");    
    availableBoostsElement.innerHTML = "";
    const unavailableBoostsElement = document.getElementById("unavailableBoosts");
    unavailableBoostsElement.innerHTML = "";
    const passiveBoostsElement = document.getElementById("passiveBoosts");
    passiveBoostsElement.innerHTML = "";

    this.#boosts.forEach((boost) => {

      const button = this.__getBonusButtonDom(boost);
      if (boost.passive) {
        passiveBoostsElement.appendChild(button);
      } else if (boost.getCanUse()) {
        availableBoostsElement.appendChild(button);
      } else {
        unavailableBoostsElement.appendChild(button);
      }
  
    });
    return;
  }

  renderHints(oPuzzle) {
    // update hints
    const oBoost = this.getBoost("Hints");
    if (
      oBoost &&
      typeof oBoost.turnsRemaining === "number" &&
      oBoost.turnsRemaining > 0
    ) {
      SidukoHtmlGenerator.updateCellHints(oPuzzle);
    } else {
      oPuzzle.getData().cells.forEach((cell) => {
        cell.element.title = "No hints remaining";
      });
    }
  }

  doTurnPlayed(bSolvedByPlayer, oPuzzle) {
    this.guessesRemaining--;

    if (this.guessesRemaining <= 0) {
      SidukoNotifications.getInstance().queueAlert("You ran out of guesses. Game over.",4000);
      window.alert("Out of guesses!!! Refresh your browser to start another puzzle");
    }

    if (bSolvedByPlayer) {
      this.#boosts
        .filter((b) => b.decrementsEachTurn && b.turnsRemaining > 0)
        .forEach((b) => {
          b.turnsRemaining--;
          if (b.turnsRemaining === 0) {
            SidukoNotifications.getInstance().queueAlert("Boost '" + b.name + "' has run out of turns.");            
            SidukoNotifications.getInstance().queueInfo("Consider buying more Hints");
            b.exhausted = true;
            if (b.name === "Hints") {
              SidukoSounds.getInstance().playSound("si_lost_hints");
            } else {
              SidukoSounds.getInstance().playSound("si_lost_bonus");
            }
          }
        });
    }

    //todo:: SidukoBonuses.canDoHomeRun(oPuzzle);
    this.renderHints(oPuzzle);

    this.renderBoosts();
  }
}
