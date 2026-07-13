class SidukoMain {
  #playerData;
  #game;
  #solution;
  #htmlGenerator;
  #eventHandler;
  #gameTimeOut;
  #gameSecondsRemaining;
  constructor(puzzleData) {  
    this.#game = new SidukoPuzzle();
    this._setGameStartData(this.#game, puzzleData);

    this.#htmlGenerator = new SidukoHtmlGenerator(this.#game);
    const tableDOM = this.#htmlGenerator.getPuzzleDOM();
    let puzzleElementHolder = document.querySelector("#everywhere table");
    if (puzzleElementHolder) {
      puzzleElementHolder.textContent = "";
    } else {
      puzzleElementHolder = document.querySelector("#everywhere");
    }
    puzzleElementHolder.appendChild(tableDOM);

    this.#solution = new SidukoPuzzle(this);
    this._setGameStartData(this.#solution, puzzleData);
    this.#game.solution = this.#solution;

    this.#playerData = new SidukoPlayerData();
    const urlParams = new URLSearchParams(window.location.search);
    const cheatMode = urlParams.get('cheat');    
    if (cheatMode  && cheatMode === "iamcheating") {
      this.#playerData.funds = 100;
    } else {
      this.#playerData.funds = SidukoConstants.DEFAULT_FUNDS;
    }        
    
    this.#playerData.guessesRemaining = -1;

    this.#playerData.puzzle = this.#game;
    this.#eventHandler = null;
    this.#gameTimeOut = null;
    this.#gameSecondsRemaining = -1;

    SidukoHtmlGenerator.updateCharset(this.#game);
    document.getElementById("boost_menu_popup").addEventListener("blur", () => {
      document.getElementById("boost_menu_popup").classList.add("hidden");
    });
    document.getElementById("boost_menu_popup_buy_button").addEventListener("click", () => {      
      if (this.__focusedBoost && this.#playerData.funds >= this.__focusedBoost.cost) {
        this.#playerData.funds -= this.__focusedBoost.cost;
        if (this.__focusedBoost.name === "Hints") {
          this.__focusedBoost.turnsRemaining += SidukoConstants.HINT_BUY_BOOST_TURNS;
        } else {
          this.__focusedBoost.turnsRemaining++;
        }
        this.__focusedBoost.exhausted = false;
        SidukoHtmlGenerator.updateCellHints(this.#game);
        this.#playerData.renderBoosts();
        document.getElementById("boost_menu_popup").classList.add("hidden");
      }
    });

    document.getElementById("boost_menu_popup_use_button").addEventListener("click", () => {
      const oBoost = this.__focusedBoost;
      if (oBoost && oBoost.getCanUse()) {
        const sBoostName = oBoost.name;       

        if (sBoostName === "Time") {
          let gameSeconds = this.#gameSecondsRemaining + SidukoConstants.TIME_BOOST_SECONDS;
          if (gameSeconds > SidukoConstants.GAME_DURATION_SECONDS) {
            gameSeconds = SidukoConstants.GAME_DURATION_SECONDS;
          }
          this.#gameSecondsRemaining = gameSeconds;
        }
        if (this.#playerData.guessesRemaining > 0 && oBoost.use()) {
        
          if (oBoost.turnsRemaining <= 0) {
            oBoost.exhausted = true;
            SidukoSounds.getInstance().playSound("si_bonus_exhausted");
            SidukoNotifications.getInstance().queueAlert(`Boost "${sBoostName}" exhausted`);     
            SidukoNotifications.getInstance().queueInfo(`Consider buying more boosts for "${sBoostName}"`);   
          }

          if (oBoost.maxCellCount > 2) {
            oBoost.maxCellCount--;
          }

          this.#playerData.renderBoosts();
          SidukoHtmlGenerator.updateCellHints(this.#game);

        } else {
          SidukoNotifications.getInstance().queueAlert(
            "Failed to use boost", 2000
          );
        }
      }        
      document.getElementById("boost_menu_popup").classList.add("hidden");
    });

    document.getElementById("boost_menu_popup_boost_button").addEventListener("click", async () => {
      const oBoost = this.__focusedBoost;
      if (this.#playerData.funds >= SidukoConstants.BOOST_UP_LEVEL_COST) {
        oBoost.maxCellCount = oBoost.maxCellCount + 1;
        this.#playerData.funds -= SidukoConstants.BOOST_UP_LEVEL_COST;
        oBoost.exhausted = oBoost.turnsRemaining <= 0;
        this.#playerData.renderBoosts();
      }
      document.getElementById("boost_menu_popup").classList.add("hidden");
    });
  }


  async _solve() {
    return new Promise(async (resolve, reject) => {
      const solver = new SidukoSolver(this.#solution, () => {});
      await solver.execute();
      resolve();
    });
  }

  stop() {
    this.#eventHandler.detatchEvents();
    if (this.#gameTimeOut) {
      window.clearInterval(this.#gameTimeOut);
      this.#gameTimeOut = null;
    }
  }

  _addInitialBoosts(oGame, oPlayerData) {
    let oBoost = new SidukoRowBoostData(
      "Row",
      "from a random row",
      oGame,
      SidukoConstants.CHAR_ROW
    );
    oPlayerData.addBoostItem(oBoost);
    oBoost.turnsRemaining = SidukoConstants.INITIAL_DEFAULT_BOOST_LIVES;
    oBoost.decrementsEachTurn = false;
    oBoost.boostBuyHint = `Increment max cell count for Rows`;
    oBoost.buyHint = `Add a rows bonus to your collection`;
    oBoost.boostable = true;
    oBoost.maxCellCount = SidukoConstants.INITIAL_DEFAULT_BOOST_CELLCOUNT;
    oBoost.exhausted = oBoost.turnsRemaining <= 0;
    oBoost.cost = 4;

    oBoost = new SidukoColumnBoostData(
      "Column",
      "from a random column",
      oGame,
      SidukoConstants.CHAR_COLUMN
    );
    oPlayerData.addBoostItem(oBoost);
    oBoost.turnsRemaining = SidukoConstants.INITIAL_DEFAULT_BOOST_LIVES;
    oBoost.decrementsEachTurn = false;
    oBoost.boostBuyHint = `Increment max cell count for Columns`;
    oBoost.buyHint = `Add a columns bonus to your collection`;
    oBoost.boostable = true;
    oBoost.maxCellCount = SidukoConstants.INITIAL_DEFAULT_BOOST_CELLCOUNT;
    oBoost.exhausted = oBoost.turnsRemaining <= 0;
    oBoost.cost = 4;

    oBoost = new SidukoInnerTableBoostData(
      "InnerTable",
      "from a random inner table",
      oGame,
      SidukoConstants.CHAR_INNER_TABLE
    );
    oPlayerData.addBoostItem(oBoost);
    oBoost.turnsRemaining = SidukoConstants.INITIAL_DEFAULT_BOOST_LIVES;
    oBoost.decrementsEachTurn = false;
    oBoost.boostBuyHint = `Increment max cell count for Inner Tables`;
    oBoost.buyHint = `Add an inner table bonus to your collection`;
    oBoost.boostable = true;
    oBoost.maxCellCount = SidukoConstants.INITIAL_DEFAULT_BOOST_CELLCOUNT;
    oBoost.exhausted = oBoost.turnsRemaining <= 0;
    oBoost.cost = 4;

    oBoost = new SidukoRandomBoostData(
      "Random",
      "randomly",
      oGame,
      SidukoConstants.CHAR_RANDOM_CELL
    );
    oPlayerData.addBoostItem(oBoost);
    oBoost.turnsRemaining = SidukoConstants.INITIAL_DEFAULT_BOOST_LIVES;
    oBoost.decrementsEachTurn = false;
    oBoost.boostBuyHint = `Increment max cell count for random`;
    oBoost.buyHint = `Add a random cell bonus to your collection`;
    oBoost.boostable = true;
    oBoost.maxCellCount = SidukoConstants.INITIAL_DEFAULT_BOOST_CELLCOUNT;
    oBoost.exhausted = oBoost.turnsRemaining <= 0;
    oBoost.cost = 6;

    oBoost = new SidukoRandomValueBoostData(
      "Random Value",
      "with a randomly chosen value",
      oGame,
      SidukoConstants.CHAR_RANDOM_VALUE
    );
    oPlayerData.addBoostItem(oBoost);
    oBoost.turnsRemaining = SidukoConstants.INITIAL_DEFAULT_BOOST_LIVES;
    oBoost.decrementsEachTurn = false;
    oBoost.boostBuyHint = `Increment max cell count for random value`;
    oBoost.buyHint = `Add a random value bonus to your collection`;
    oBoost.boostable = true;
    oBoost.maxCellCount = SidukoConstants.INITIAL_DEFAULT_BOOST_CELLCOUNT;
    oBoost.exhausted = oBoost.turnsRemaining <= 0;
    oBoost.cost = 4;

    oBoost = new SidukoSeekerBoostData(
      "Seeker",
      "values that can only exist in 1 cell",
      oGame,
      SidukoConstants.CHAR_SEEKER
    );
    oBoost.turnsRemaining = SidukoConstants.INITIAL_SEEKER_LIVES;
    oBoost.decrementsEachTurn = false;
    oPlayerData.addBoostItem(oBoost);
    oBoost.boostBuyHint = "Increase the max cell count for the Seeker bonus";
    oBoost.buyHint = `Add another seeker bonus to be used when you choose`;
    oBoost.boostable = true;
    oBoost.maxCellCount = SidukoConstants.INITIAL_DEFAULT_BOOST_CELLCOUNT;
    oBoost.exhausted = oBoost.turnsRemaining <= 0;   
    oBoost.cost = 3; // cost is lower, as the user could solve this easily


    oBoost = new SidukoBadValueRemovalBoostData(
      "Eraser",
      "which contain an incorrect value, and corrects them",
      oGame,
      SidukoConstants.CHAR_ERASE_BAD
    );
    oBoost.turnsRemaining = SidukoConstants.INITIAL_DEFAULT_BOOST_LIVES;
    oBoost.decrementsEachTurn = false;
    oPlayerData.addBoostItem(oBoost);
    oBoost.boostBuyHint = "Increase the max cell count for the Eraser bonus";
    oBoost.buyHint = `Add another Eraser bonus to be used when you choose`;;
    oBoost.boostable = true;
    oBoost.maxCellCount = SidukoConstants.INITIAL_DEFAULT_BOOST_CELLCOUNT;
    oBoost.exhausted = oBoost.turnsRemaining <= 0;
    oBoost.cost = 4;

    oBoost = new SidukoHighlightBoostData(
      "Highlight",
      "with incorrect values and highlights them [this will only be available when you're off-track]",
      oGame,
      SidukoConstants.CHAR_HIGHLIGHT_BAD
    );    
    oBoost.turnsRemaining = SidukoConstants.INITIAL_DEFAULT_BOOST_LIVES;
    oBoost.decrementsEachTurn = false;
    oPlayerData.addBoostItem(oBoost);
    oBoost.boostBuyHint = "Increase the max cell count for the Highlight bonus";
    oBoost.buyHint = `Add another Highlight bonus to be used when you choose`;;
    oBoost.boostable = true;
    oBoost.maxCellCount = SidukoConstants.INITIAL_DEFAULT_BOOST_CELLCOUNT;
    oBoost.exhausted = oBoost.turnsRemaining <= 0;
    oBoost.cost = 3;

    // Show tooltips on each turn whilst we still have turns remaining
    oBoost = new SidukoHintsBoostData(
      "Hints",
      "Shows tooltips for the possible values in a cell",
      oGame,
      SidukoConstants.CHAR_HINT
    );
    oPlayerData.addBoostItem(oBoost);
    oBoost.turnsRemaining = SidukoConstants.HINT_BUY_BOOST_TURNS;
    oBoost.decrementsEachTurn = true;
    oBoost.buyHint = `Add tooltip hints for another ${SidukoConstants.HINT_BUY_BOOST_TURNS}`;
    oBoost.boostable = false;
    oBoost.maxCellCount = null;
    oBoost.cost = 1;

    oBoost = new SidukoBoostData(
      "Time",
      `Adds a maximum of ${SidukoConstants.TIME_BOOST_SECONDS} seconds to the timer`,
      oGame,
      SidukoConstants.CHAR_CLOCK
    );
    oBoost.turnsRemaining = 0;
    oBoost.decrementsEachTurn = false;
    oPlayerData.addBoostItem(oBoost);
    oBoost.buyHint = `Add a time boost bonus to be used when you choose`;
    oBoost.boostable = false;
    oBoost.maxCellCount = null;
    oBoost.exhausted = oBoost.turnsRemaining <= 0;
    oBoost.cost = 2;

    oBoost = new SidukoHomeRunBoostData(
      "Home run",
      `Auto completes puzzle when just single value cells remain`,
      oGame,
      SidukoConstants.CHAR_BASEBALL
    );
    oBoost.passive = true;
    oBoost.turnsRemaining = 0;
    oBoost.decrementsEachTurn = false;
    oPlayerData.addBoostItem(oBoost);
    oBoost.boostable = false;
    oBoost.maxCellCount = null;
    oBoost.exhausted = false;
    oBoost.forSale = false;
    
  }


  async start() {

    // Increase games played
    if (typeof Storage !== "undefined") {
      if (!localStorage.gamesStarted) {
        localStorage.gamesStarted = 1;
      } else {
        localStorage.gamesStarted++;
      }
      console.log(`Games started: ${localStorage.gamesStarted}`);
    }

    const intro = document.getElementById("introScreen");
    const introListener = intro.addEventListener("animationend", () => {
        intro.removeEventListener("animationend", introListener);
        intro.classList.remove("fadeIntro");
        intro.style.display = "none";      
      }
    );
          
    intro.classList.add("fadeIntro");

    
    if (this.#gameTimeOut) {
      window.clearInterval(this.#gameTimeOut);
      this.#gameTimeOut = null;
    }
    await this._solve();
    document.getElementById("menucontainer").style.display = "none";
    const oPlayerData = this.#playerData;
    const oGame = this.#game;

    const aEmptyCells = this.#game.getData().cells.filter((cell) => cell.value === 0);

    let randomBonusIndex = Math.floor(Math.random() * aEmptyCells.length -1);
    if (randomBonusIndex >= 0) {     
      aEmptyCells[randomBonusIndex].bonusTrigger = true;
      aEmptyCells[randomBonusIndex].element.innerText = "B";
    }

    if (Math.random() < 0.3) {
      const aRemainingCells = aEmptyCells.filter((cell) => !cell.bonusTrigger);
      randomBonusIndex = Math.floor(Math.random() * aRemainingCells.length -1);
      if (randomBonusIndex >= 0) {        
        aRemainingCells[randomBonusIndex].randomBonusTrigger = true;
      }
    }
    
    oPlayerData.guessesRemaining = Math.round(aEmptyCells.length * SidukoConstants.GUESSES_MULTIPLER);

    this.#htmlGenerator = new SidukoHtmlGenerator(this.#game);
    const tableDOM = this.#htmlGenerator.getPuzzleDOM();
    let puzzleElementHolder = document.querySelector("#everywhere table");
    if (puzzleElementHolder) {
      puzzleElementHolder.textContent = "";  
    } else {
      puzzleElementHolder = document.querySelector("#everywhere");
    }
    puzzleElementHolder.appendChild(tableDOM);
    
    if (this.#eventHandler) {
      this.#eventHandler.detatchEvents();
      this.#eventHandler = null;
    }

    this.#eventHandler = new SidukoEventsHandler(
      this.#game,
      tableDOM,
      this.#playerData,
      this.#game.solution      
    );
    this.#eventHandler.attachEvents();
    this.#eventHandler.addEventListener("levelComplete", () => {
      //TODO::
      if (typeof Storage !== "undefined") {
        let mostTimeRemaining = localStorage.mostTimeRemaining;
        if (!mostTimeRemaining || mostTimeRemaining < this.#gameSecondsRemaining) {
          localStorage.mostTimeRemaining = this.#gameSecondsRemaining;
          console.log(`Most time remaining: ${localStorage.mostTimeRemaining}`);
        }
        console.log(`Time remaining: ${this.#gameSecondsRemaining}`);
      }

      window.clearInterval(this.#gameTimeOut);
      this.#gameTimeOut = null;
      SidukoNotifications.getInstance().queueAlert(`Level Complete! ${this.#gameSecondsRemaining} seconds remaining`);
    });

    this._addInitialBoosts(oGame,oPlayerData);
    oPlayerData.renderBoosts();

    document.getElementById("boostinformation").addEventListener(
      "click",
      (oEv) => {
        if (this.#playerData.guessesRemaining <= 0) {
          return;
        }
        if (!oEv.target.classList.contains("boost_glyph")) {
          return;
        }

        const sBoostName = oEv.target.dataset["boostName"];
        let oBoost = oPlayerData.getBoost(sBoostName);
        this.__focusedBoost = this.#playerData.getBoost(sBoostName);

        const oBoostPopup = document.getElementById("boost_menu_popup");        
        document.getElementById("boost_menu_popup_text").innerText = oBoost.description;
        if (oBoost.passive) {
          document.getElementById("boost_menu_popup_lives").innerText = "";
          document.getElementById("boost_menu_popup_lives").classList.remove("no_lives_left");

        } else {
          document.getElementById("boost_menu_popup_lives").innerText = oBoost.turnsRemaining ? "Lives remaining: " + oBoost.turnsRemaining : "No lives left";
          if (oBoost.turnsRemaining <= 0 &&!oBoost.decrementsEachTurn) {
            document.getElementById("boost_menu_popup_lives").classList.add("no_lives_left");
          } else {
            document.getElementById("boost_menu_popup_lives").classList.remove("no_lives_left");
          }
        }
        if (oBoost.boostable) {
          const sPrefix = `Reveals up to ${oBoost.maxCellCount} cells `
          document.getElementById("boost_menu_popup_text").innerText = sPrefix + oBoost.description;
        }        
        if (oBoost.getCanUse() && !oBoost.decrementsEachTurn) {
          document.getElementById("boost_menu_popup_use_button").classList.remove("hidden");
          document.getElementById("boost_menu_popup_use_button").title = oBoost.hint;
        } else {
          document.getElementById("boost_menu_popup_use_button").classList.add("hidden");
        }
        if ((this.#playerData.funds >= oBoost.cost) && (!oBoost.passive)) {
          document.getElementById("boost_menu_popup_buy_button").classList.remove("hidden");
          document.getElementById("boost_menu_popup_buy_button").innerText = `Buy: $${oBoost.cost}`;        
        } else {
          document.getElementById("boost_menu_popup_buy_button").classList.add("hidden");
        }        
        if (oBoost.boostable && (this.#playerData.funds >= SidukoConstants.BOOST_UP_LEVEL_COST)) {
          document.getElementById("boost_menu_popup_boost_button").innerText = `Boost: $${SidukoConstants.BOOST_UP_LEVEL_COST}`;
          document.getElementById("boost_menu_popup_boost_button").classList.remove("hidden");             
          document.getElementById("boost_menu_popup_boost_button").title = oBoost.boostBuyHint;
        } else {
          document.getElementById("boost_menu_popup_boost_button").classList.add("hidden");
        }        
        oBoostPopup.style.left = `${oEv.clientX}px`;
        oBoostPopup.style.top = `${oEv.clientY}px`;
        oBoostPopup.classList.remove("hidden");
        oBoostPopup.focus();

        oPlayerData.renderBoosts(oGame);
        oPlayerData.renderHints(oGame);
      },
      this
    );

    if (this.#gameTimeOut) {
      window.clearInterval(this.#gameTimeOut);
      this.#gameTimeOut = null;
    }
    this.#gameSecondsRemaining = SidukoConstants.GAME_DURATION_SECONDS;
    SidukoSounds.getInstance().playSound("all systems go");
    document.getElementById("mainGameArea").classList.remove("gameStart");
    document.getElementById("mainGameArea").classList.remove("hidden");
    document.getElementById("mainGameArea").classList.add("gameStart");
    this.#gameTimeOut = window.setInterval(
      () => {
        if (this.#gameSecondsRemaining > 0) {
          this.#gameSecondsRemaining--;

          const totalWidth = document.getElementById("progressBarProgress")
            .parentElement.clientWidth;
          const w = Math.round(
            (this.#gameSecondsRemaining /
              SidukoConstants.GAME_DURATION_SECONDS) *
              totalWidth
          );
          document.getElementById("progressBarProgress").style.width = `${w}px`;
          document.getElementById("progressBarTextOverlay").innerText = `${
            this.#gameSecondsRemaining
          } seconds remaining`;

          if (this.#gameSecondsRemaining < 31 && this.#gameSecondsRemaining  % 5 === 0) {
            SidukoNotifications.getInstance().queueAlert(`Warning: ${this.#gameSecondsRemaining} seconds left`);
          }
        } else {
          window.clearInterval(this.#gameTimeOut);
          this.#gameTimeOut = null;
          
          // Record games timed out.
          if (typeof Storage !== "undefined") {
            if (!localStorage.gamesStarted) {
              localStorage.gamesTimedOut = 1;
            } else {
              localStorage.gamesTimedOut++;
            }
            console.log(`Games Timedout: ${localStorage.gamesTimedOut}`);
          }

          window.alert(
            "You ran out of time!\nTechnically speaking the game is over and you lost.\nFeel free to carry on playing, or refresh to start another puzzle."
          );        
        }
      },
      1000,
      this
    );
  }

  /**
   * Initializes the game with the provided puzzle data, generates a solution, and renders the game.
   *
   * @param {Object} puzzleData - The initial puzzle data to set up the game.
   *                              Expected to contain the necessary information to populate the game grid.
   * @returns {void} This function does not return a value.
   */
  _setGameStartData(oGame, aStartData) {
    const gameData = oGame.getData();
    for (let i = 0; i < aStartData.length; i++) {
      let iValue = parseInt(aStartData[i], 10);
      const oCell = gameData.cells[i];
      if (iValue > 0) {
        oCell.value = iValue;
        oCell.setFixedValue();
      } else {
        if (oCell) {
          oCell.setEmptyValue();
        }
      }
    }
  }
}
