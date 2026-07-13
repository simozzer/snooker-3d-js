class SidukoEventsHandler {
  #tableDomElement;
  #puzzle;
  #playerData;
  #focusedCell;
  #cellValueEntry;
  #registeredListeners;

  constructor(oPuzzle, oTableDomElement, playerData) {
    this.#tableDomElement = oTableDomElement;
    this.#puzzle = oPuzzle;
    this.#playerData = playerData;
    this.#focusedCell = null;    
    this.#cellValueEntry = document.getElementById("cellValueEntryPopup");
    this.#registeredListeners = {};
    this.attachEvents();
  }

  addEventListener(name, callback) {
    if (!this.#registeredListeners[name]) this.#registeredListeners[name] = [];
    this.#registeredListeners[name].push(callback);
  }
  
  triggerEvent(name, args) {
     this.#registeredListeners[name]?.forEach(fnc => fnc.apply(this, args));
  }
    

  get focusedCell() {
    return this.#focusedCell;
  }

  set focusedCell(cell) {
    this.#focusedCell = cell;
  }

  attachEvents() {
    this.#tableDomElement.addEventListener("click", this._onTap.bind(this));
    this.#cellValueEntry.addEventListener(
      "click",
      this._onCellValueEntryChange.bind(this)
    );
    this.#cellValueEntry.addEventListener(
      "blur",
      this._onCellValueEntryBlur.bind(this)
    );
  }

  detatchEvents() {
    this.#tableDomElement.removeEventListener("click", this._onTap.bind(this));
    this.#cellValueEntry.removeEventListener(
      "click",
      this._onCellValueEntryChange.bind(this)
    );
    this.#cellValueEntry.removeEventListener(
      "blur",
      this._onCellValueEntryBlur.bind(this)
    );
  }

 
  async gameplayChangedHandler(state) {
    const oGame = this.#puzzle;    
    let bonus = 0;
    if (state) {
      if (state.column) {        
        if (
          oGame
            .getData()
            .cellsInColumn(state.column - 1)
            .map((o) => o.value)
            .toString() ===
          oGame.solution
            .getData()
            .cellsInColumn(state.column - 1)
            .map((o) => o.value)
            .toString()
        ) {
          oGame
            .getData()
            .cellsInColumn(state.column - 1)
            .forEach((cell) => {
              if (!cell.fixedValue) {
                cell.element.classList.add("player_solved");
                cell.setFixedValue();
              }
            });
          SidukoNotifications.getInstance().queueInfo("Column matches solution. Bonus awarded");
          SidukoSounds.getInstance().playSound("si_correct_row");
          bonus++;
        } else {
          SidukoNotifications.getInstance().queueAlert("Column Does not match solution. No bonus awarded");
          SidukoSounds.getInstance().playSound("si_incorrect_row");
        }
        SidukoHtmlGenerator.highlightColumn(oGame, state.column - 1);
      }
      if (state.row) {        
        if (
          oGame
            .getData()
            .cellsInRow(state.row - 1)
            .map((o) => o.value)
            .toString() ===
          oGame.solution
            .getData()
            .cellsInRow(state.row - 1)
            .map((o) => o.value)
            .toString()
        ) {
          oGame
            .getData()
            .cellsInRow(state.row - 1)
            .forEach((cell) => {
              if (!cell.fixedValue) {
                cell.element.classList.add("player_solved");
                cell.setFixedValue();
              }
            });
          SidukoNotifications.getInstance().queueInfo("Row matches solution. Bonus awarded");
          SidukoSounds.getInstance().playSound("si_correct_row");
          bonus++;
        } else {
          SidukoNotifications.getInstance().queueAlert("Row Does not match solution. No bonus awarded");
          SidukoSounds.getInstance().playSound("si_incorrect_row");
        }
        SidukoHtmlGenerator.highlightRow(oGame, state.row - 1);
      }
      if (state.innerTable) {        
        if (
          oGame
            .getData()
            .cellsInInnerTable(state.innerTable - 1)
            .map((o) => o.value)
            .toString() ===
          oGame.solution
            .getData()
            .cellsInInnerTable(state.innerTable - 1)
            .map((o) => o.value)
            .toString()
        ) {
          oGame
            .getData()
            .cellsInInnerTable(state.innerTable - 1)
            .forEach((cell) => {
              if (!cell.fixedValue) {
                cell.element.classList.add("player_solved");
                cell.setFixedValue();
              }
            });
          SidukoNotifications.getInstance().queueInfo("Inner table matches solution. Bonus awarded");
          SidukoSounds.getInstance().playSound("si_correct_row");
          bonus++;
        } else {
          SidukoNotifications.getInstance().queueAlert("Inner table does not match solution. No bonus awarded");
          SidukoSounds.getInstance().playSound("si_incorrect_row");
        }
        SidukoHtmlGenerator.highlightInnerTable(oGame, state.innerTable - 1);
      }
      if (state.board) {
        logMessage(`🔥🔥🔥***Board Filled***🔥🔥🔥`, "board_filled");      
        SidukoElementEffects.explodeAllCells();

        // Increase puzzles solved
        if (typeof Storage !== "undefined") {
          if (!localStorage.puzzlesSolved) {
            localStorage.puzzlesSolved = 1;
          } else {
            localStorage.puzzlesSolved++;
          }
          console.log(`puzzles solved: ${localStorage.puzzlesSolved}`);
        }              

        this.triggerEvent("levelComplete", [false]);
      }

      if (state.badGuess) {
        if (this.#playerData.guessesRemaining >= SidukoConstants.SPAM_GUESS_PENALTY) {
          SidukoNotifications.getInstance().queueAlert("Spamming guesses looses you some of your remaining guesses!!!");
          this.#playerData.guessesRemaining -= SidukoConstants.SPAM_GUESS_PENALTY;
        }        
      }

      if (bonus > 0) {
        const reward = Math.floor(bonus *1.8);
        SidukoNotifications.getInstance().queueBonus(`Bonus awarded! You've gained $${reward}!`);        
        this.#playerData.funds += reward;
        this.#playerData.renderBoosts();
      }

      if (state.playerCellUsed) {
        console.log("Cell used by player");
        this.#playerData.doTurnPlayed(true, oGame);
      } else if (state.cellUsed) {
        console.log("cell used by A bonus");
        this.#playerData.doTurnPlayed(false, oGame);
      } else {
        console.log("Unknown state");
      }

      const oHomeRunBoost = this.#playerData.getBoost("Home run");
      if (oHomeRunBoost && oHomeRunBoost.getCanUse()) {        
        await oHomeRunBoost.use();        
        logMessage(`🔥🔥🔥***Board Filled***🔥🔥🔥`, "board_filled");      
        SidukoElementEffects.explodeAllCells();

        // Increase puzzles solved
        if (typeof Storage !== "undefined") {
          if (!localStorage.puzzlesSolved) {
            localStorage.puzzlesSolved = 1;
          } else {
            localStorage.puzzlesSolved++;
          }
          console.log(`puzzles solved: ${localStorage.puzzlesSolved}`);
        }              

        this.triggerEvent("levelComplete", [false]);
      }


      this.__letJohnMessYourHeadUp();
      this.__swapDigits();
      this.__spinCircles();

    }
  }


  __letJohnMessYourHeadUp() {
    // Do some random shit      
    if (Math.random() < 0.05) {
      //SidukoNotifications.getInstance().queueAlert("John just messed with your head!!!");
      const allCells  = this.#puzzle.getData().cells.filter((cell) => Boolean(cell.value));
      if (allCells && allCells.length > 0) {
        const iRandomCellIndex = Math.floor(Math.random() * allCells.length);
        const oCell = allCells[iRandomCellIndex];
        if (oCell && oCell.element) {
          if (Math.random() < 0.5) {
            const fnFlipVertAnimEnd = () => {
              oCell.element.classList.add("flippedVert");
              oCell.element.classList.remove("flipVert");
              oCell.element.removeEventListener("animationend", fnFlipVertAnimEnd);
            }
            oCell.element.addEventListener("animationend", fnFlipVertAnimEnd);
            oCell.element.classList.add("flipVert");
          } else {
            const fnFlipHorzAnimEnd = () => {
              oCell.element.classList.add("flippedHorz");
              oCell.element.classList.remove("flipHorz");
              oCell.element.removeEventListener("animationend", fnFlipHorzAnimEnd);
            }
            oCell.element.addEventListener("animationend", fnFlipHorzAnimEnd);
            oCell.element.classList.add("flipHorz");
          }
        }
      }
    }
  }

  __doWordSearch() {
   // const searcher = new SidukoWordSearch(this.#puzzle, SidukoConstants.RUDE_SET_WORD_LIST);
    
    
    // DO NOT USE WHEN CHARS CAN BESWAPPED searcher.findWords();
    
  }

  async __swapDigits() {
    if (Math.random() > 0.96) {
      const iDigitIndex = Math.floor(Math.random() * 9);
      let iOtherDigitIndex = Math.floor(Math.random() * 9);
      while (iOtherDigitIndex === iDigitIndex) {
        iOtherDigitIndex = Math.floor(Math.random() * 9);
      }
      const aSourceCells = this.#puzzle.solution.getData().cells.filter(
        (cell) => cell.value === iDigitIndex +1
      );
      const aTargetCells = this.#puzzle.solution.getData().cells.filter(
        (cell) => cell.value === iOtherDigitIndex +1
      );
      if (aSourceCells.length !== aTargetCells.length) {
        window.alert("Cannot swap digits.. length mismatch");
        return;
      }
      if (aSourceCells.length !== 9) {
        window.alert("Cannot swap digits.. length incorrect");
        return;
      }
    
      const sourceChar = this.#puzzle.charset[iDigitIndex];
      const swapChar = this.#puzzle.charset[iOtherDigitIndex];

      this.#puzzle.charset[iDigitIndex] = swapChar;
      this.#puzzle.charset[iOtherDigitIndex] = sourceChar;


      const aSourceCellElements = aSourceCells.map(cell => {
        const col = cell.column;
        const row = cell.row;
        const oCell = this.#puzzle.getData().cell(col, row);
        return oCell;
      });
      console.log("SOURCE: " + aSourceCellElements.map(cell => cell.column + "," + cell.row + "(" + cell.element.getBoundingClientRect().left + "," + cell.element.getBoundingClientRect().top + ")"));

      const aTargetCellElements = aTargetCells.map(cell => {
        const col = cell.column;
        const row = cell.row;
        const oCell = this.#puzzle.getData().cell(col, row);
        return oCell;
      });
      console.log("TRAGET: " + aTargetCellElements.map(cell => cell.column + "," + cell.row + "(" + cell.element.getBoundingClientRect().left + "," + cell.element.getBoundingClientRect().top + ")"));
      let iCellIndex = 0
      while (iCellIndex < aSourceCellElements.length && iCellIndex < aTargetCellElements.length) {
        const oSourceElem = aSourceCellElements[iCellIndex].element;
        const oTargetElem = aTargetCellElements[iCellIndex].element;
        const oSourceOverlay = SidukoElementEffects.getElementOverlay(oSourceElem);
        oSourceOverlay.innerText = oSourceElem.innerText;
        const oTargetOverlay = SidukoElementEffects.getElementOverlay(oTargetElem);
        oTargetOverlay.innerText = oTargetElem.innerText;
        document.body.appendChild(oSourceOverlay);
        document.body.appendChild(oTargetOverlay);
        const oSourceOriginX = parseInt(oSourceElem.getBoundingClientRect().left, 10);
        const oSourceOriginY = parseInt(oSourceElem.getBoundingClientRect().top, 10);
        const oTargetOriginX = parseInt(oTargetElem.getBoundingClientRect().left, 10);
        const oTargetOriginY = parseInt(oTargetElem.getBoundingClientRect().top, 10);

        const framesToSlide = 15;
        const deltaX = (oSourceOriginX - oTargetOriginX) / framesToSlide;
        const deltaY = (oSourceOriginY - oTargetOriginY) / framesToSlide;
        for (let i = 0; i < framesToSlide; i++) {
          oSourceOverlay.style.left = `${Math.round(oSourceOriginX - (i* deltaX))}px`;
          oSourceOverlay.style.top = `${Math.round(oSourceOriginY - (i* deltaY))}px`;
          oTargetOverlay.style.left = `${Math.round(oTargetOriginX + (i* deltaX))}px`;
          oTargetOverlay.style.top = `${Math.round(oTargetOriginY + (i* deltaY))}px`;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        oSourceOverlay.style.left = oTargetOriginX + "px";
        oSourceOverlay.style.top = oTargetOriginY + "px";
        oTargetOverlay.style.left = oSourceOriginX + "px";
        oTargetOverlay.style.top = oSourceOriginY + "px";
        document.body.removeChild(oSourceOverlay);
        document.body.removeChild(oTargetOverlay);
        iCellIndex++;
      }

      SidukoHtmlGenerator.updateCharset(this.#puzzle);
      SidukoNotifications.getInstance().queueAlert("Some digits have been swapped!!!");
    }
  }

  __spinCircles() {

    const oCirclesAnimationElement = document.querySelector(".circles");
    const oClassList = oCirclesAnimationElement.classList;

    if (oClassList.contains("spinLeft") || oClassList.contains("spinRight") || oClassList.contains("flipHorz") || oClassList.contains("flipVert")) {
      return;      
    }

    const area = document.querySelector(".area");
    area.classList.remove("color1");
    area.classList.remove("color2");
    area.classList.remove("color3");
    area.classList.remove("color4");
    const c = Math.floor(Math.random() * 3);
    area.classList.add(`color${c + 1}`);

    var isChrome = /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
    if (isChrome) {
      return;
    }
    //TODO disable for now as it doesn't work on some phones

    const fnRemoveSpin = () => {
      oClassList.remove("spinLeft");      
      oClassList.remove("spinRight");
      oClassList.remove("flipHorz");
      oClassList.remove("flipVert");
      oCirclesAnimationElement.removeEventListener("animationend", fnRemoveSpin);
    }
    
    oClassList.remove("spinLeft");      
    oClassList.remove("spinRight");
    oClassList.remove("flipHorz");
    oClassList.remove("flipVert");
    oCirclesAnimationElement.addEventListener("animationend", fnRemoveSpin);
    const r = Math.random();
    
    if (r > 0.75) {
      oClassList.add("spinLeft");
    } else if (r > 0.5) {
      oClassList.add("spinRight");
    } else if (r > 0.25) {
      oClassList.add("flipHorz");
    } else {
      oClassList.add("flipVert");
    }      
  }

  __showValueEntryPopup(oEvent) {
    if (this.__lastFocusedCell == this.#focusedCell) {
      console.log("same cell");

    } else {
      this.__lastFocusedCell = this.#focusedCell;
      this.__badGuessCount = 0;
      console.log("new cell");
    }
    const aPossibleValues = SidukoCellQueries.getPossibleValues(
      this.#puzzle.getData(),
      this.#focusedCell
    );
    const valueEntryTds = Array.from(
      document.querySelectorAll("#cellValueEntryPopup td")
    );
    valueEntryTds.forEach((td) => {
      
      const sCellValue = td.innerText;
      const iValIndex = this.#puzzle.charset.indexOf(sCellValue);
      if (iValIndex >= 0 && this.#playerData.getBoost("Hints").turnsRemaining > 0 &&
          aPossibleValues.indexOf(iValIndex+1) >= 0) 
      {
        td.classList.add("suggested");
      } else {
        td.classList.remove("suggested");
      }
    });
    this.#cellValueEntry.style.top = oEvent.clientY + "px";
    this.#cellValueEntry.style.left = oEvent.clientX + "px";

    
    const valueClearButton = document.getElementById("cellValueClearButton");
    if (this.#focusedCell.value) {
      valueClearButton.classList.remove("hidden");
    } else {
      valueClearButton.classList.add("hidden");
    }
    this.#cellValueEntry.classList.remove("hidden");
    this.#cellValueEntry.focus();


    // Ensure popup menu can bee seen
    const popupWidth = this.#cellValueEntry.getBoundingClientRect().width;
    if (oEvent.clientX + popupWidth > document.body.clientWidth - 5) {
      this.#cellValueEntry.style.left = (document.body.clientWidth - popupWidth - 5) + "px";
    }
    const popupHeight = this.#cellValueEntry.getBoundingClientRect().height;
    if (oEvent.clientY + popupHeight > document.body.clientHeight - 5) {
      this.#cellValueEntry.style.top = (document.body.clientHeight - popupHeight - 5) + "px";
    }
  }


  _onTap(oEvent) {
    const oEventTarget = oEvent.target;

    console.log(`Tap: elem: ${oEventTarget.dataset}`);

    if (oEventTarget.nodeName === "TD") {
      if (!oEventTarget.classList.contains("fixedval")) {
        const column = 0 | oEventTarget.dataset.column;
        const row = 0 | oEventTarget.dataset.row;
        this.#focusedCell = this.#puzzle.getData().cell(column, row);
        if (this.#focusedCell.fixedValue) {
          return;
        }
        this.__showValueEntryPopup(oEvent);
        oEvent.stopImmediatePropagation();
      }
    }
  }

  __triggerBonuses(oCellData) {
    const oSolutionCell = this.#puzzle.solution.getData().cell(
      oCellData.column,
      oCellData.row
    );
    if (oCellData.bonusTrigger) {
      oCellData.bonusTrigger = false;  

      if (oSolutionCell.value === oCellData.value) {
        SidukoNotifications.getInstance().queueBonus("Bonus triggered...have some free money!");
        this.#playerData.funds++;
      } else {
        SidukoNotifications.getInstance().queueBonus("Penalty triggered...that'll cost you!");
        if (this.#playerData.funds > 0) {
          this.#playerData.funds--;
        } else if (this.#playerData.guessesRemaining > 5) {
          this.#playerData.guessesRemaining = this.#playerData.guessesRemaining - 5;                    
        }
      }           
    }  

    /*
    if (oCellData.randomBonusTrigger) {
      oCellData.randomBonusTrigger = false;
      if (oSolutionCell.value === oCellData.value) {
        SidukoNotifications.getInstance().queueBonus("Correct Value. Random bonus triggered!");
        SidukoBonuses.triggerRandomBonus(this.#puzzle,()=>{});              
      } else {
        SidukoNotifications.getInstance().queueBonus("Incorrect value. Random bonus failed!");  
      }            
    } 
      */

    
 
  }

  _onCellValueEntryChange(oEvent) {
    const oCellData = this.#focusedCell;
    if (oCellData.fixedValue) {
      return;
    }

    const valueEntry = document.getElementById("cellValueEntryPopup");
    if (oEvent.target.innerText === "Clear") {
      oCellData.value = 0;
      oCellData.entered = false;
      oCellData.element.innerText = "";
      oCellData.element.classList.remove("entered");
      oCellData.element.title = "";

      valueEntry.classList.add("hidden");
      oEvent.stopImmediatePropagation();
      this._updateCellHints();
      SidukoSounds.getInstance().playSound("si_eraser");
      return;
    }


    
    const sClickedValue = oEvent.target.innerText;
    const iValIndex = this.#puzzle.charset.indexOf(sClickedValue);
    if (iValIndex >= 0 && iValIndex < 9) {
      const iValue = iValIndex + 1;
      if (
        SidukoCellQueries.canSetValue(this.#puzzle.getData(), oCellData, iValue)
      ) {
        const oStartFullnessState = SidukoCellQueries.getFullnessState(
          this.#puzzle.getData(),
          oCellData
        );

        oCellData.value = iValue || 0;
        oCellData.entered = true;
        oCellData.element.innerText = this.#puzzle.charset[iValue-1];
        oCellData.element.classList.add("entered");
        oCellData.element.title = "";

        const oEndFullnessState = SidukoCellQueries.getFullnessState(
          this.#puzzle.getData(),
          oCellData
        );
        let oFullnessStateChanges = SidukoCellQueries.getFullnessStateChanges(
          oStartFullnessState,
          oEndFullnessState,
          oCellData
        );
        if (!oFullnessStateChanges) {
          oFullnessStateChanges = {};
        }
        oFullnessStateChanges.playerCellUsed = true;
        oFullnessStateChanges.cell = oCellData;
        this.gameplayChangedHandler(oFullnessStateChanges);
        valueEntry.classList.add("hidden");

        const fnAnimEnd = (oEvent) => {
          oCellData.element.removeEventListener("animationend", fnAnimEnd);
          oCellData.element.classList.remove("value_entered");
        };
        oCellData.element.addEventListener("animationend", fnAnimEnd);
        oCellData.element.classList.add("value_entered");

        this._updateCellHints();
        this.__triggerBonuses(oCellData);
        SidukoSounds.getInstance().playSound("Click1");
        SidukoElementEffects.slideCellOut(oCellData.element);  


        // update the status for entry timeout
        if (this.__entryTimeout) {
          if (oCellData.value === this.#puzzle.solution.getData().cell(oCellData.column, oCellData.row).value) {
            this.__entryTimeoutBonus = this.__entryTimeoutBonus ? this.__entryTimeoutBonus + 1 : 1;
          } else {
            //incorrect answers in a streak will be penalised
            if (this.__entryTimeoutBonus > 0) {
                this.__entryTimeoutBonus -= 1;
            }            
          }
          console.log("Entry bonus: " + this.__entryTimeoutBonus);
          window.clearTimeout(this.__entryTimeout);
          this.__entryTimeout = null;
        }
        
        document.getElementById("entryTimerBarContainer").classList.remove("hidden");
        const entryStartTime = Date.now();
        const entryEndTime = entryStartTime + SidukoConstants.QUICK_STREAK_TIMEOUT;
        this.__entryTimeout = window.setInterval(() => {
          const timeRemaining = entryEndTime - Date.now();
          const percentAsWidth = Math.trunc((100 * timeRemaining / SidukoConstants.QUICK_STREAK_TIMEOUT));
          document.getElementById("entryTimerBarProgress").style.width = percentAsWidth + "%";
          if (timeRemaining <= 0) {
            if ((!this.__lastEntryTimeoutBonus) || this.__entryTimeoutBonus > this.__lastEntryTimeoutBonus) {
              this.__lastEntryTimeoutBonus = this.__entryTimeoutBonus;
              if (this.__lastEntryTimeoutBonus > 1) {               
                SidukoNotifications.getInstance().queueInfo(`a quick streak of ${this.__lastEntryTimeoutBonus} - best this game!`)
              }
            }
          
            window.clearInterval(this.__entryTimeout);
            this.__entryTimeout = null;
            document.getElementById("entryTimerBarContainer").classList.add("hidden");
            this.__entryTimeoutBonus = 0;
          }
          
        }, 100);
      } else {
        if (!this.__badGuessCount) {
          this.__badGuessCount = 1;          
        } else {
          //TODO:: Each click reduce count
          this.__badGuessCount++;
          if (this.__badGuessCount > 3) {
            this.gameplayChangedHandler({badGuess: true});
            SidukoNotifications.getInstance().queueAlert("You're just spamming the guesses, aren't you?.");
            this.__badGuessCount = 0;
          }
        }
      }

      oEvent.stopImmediatePropagation();
    }
  }

  _updateCellHints() {
    const oBoost = this.#playerData.getBoost("Hints");
    if (
      oBoost &&
      typeof oBoost.turnsRemaining === "number" &&
      oBoost.turnsRemaining > 0
    ) {
      SidukoHtmlGenerator.updateCellHints(this.#puzzle);
    } else {
      this.#puzzle.getData().cells.forEach((cell) => {
        cell.element.title = "N/A";
      });
    }
  }

  _onCellValueEntryBlur(oEvent) {
    const valueEntry = document.getElementById("cellValueEntryPopup");
    valueEntry.classList.add("hidden");
    oEvent.stopImmediatePropagation();
  }
}
