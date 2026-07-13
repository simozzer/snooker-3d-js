class SidukoBonuses {

  static revealRandomValue(
    oPuzzle,
    fnGameEventCallback,
    bonusData
  ) {
    if (typeof fnGameEventCallback !== "function") {
      throw new Error("Invalid callback function");
    }
    const emptyCells = oPuzzle.getData().cells.filter((c) => c.value === 0);
    if (emptyCells.length === 0) {
      return;
    }

    const iMaxCells = bonusData.maxCellCount;
    let iCellsRevealed = 0;
    for (let i = 0; i < iMaxCells; i++) {
      if (iCellsRevealed >= iMaxCells) {
        break;
      }
      const randomCell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
      const sourceCell = oPuzzle.solution
        .getData()
        .cell(randomCell.column, randomCell.row);

      if (
        randomCell.value <= 0 &&
        SidukoCellQueries.canSetValue(
          oPuzzle.getData(),
          randomCell,
          sourceCell.value
        )
      ) {
        const oStartFullnessState = SidukoCellQueries.getFullnessState(
          oPuzzle.getData(),
          randomCell
        );

        randomCell.value = sourceCell.value;
        randomCell.element.innerHTML = oPuzzle.charset[sourceCell.value-1];
        randomCell.setSolved();
        randomCell.element.classList.add("aided");
        randomCell.element.classList.add("granted");
        randomCell.entered = true;      

        const oEndFullnessState = SidukoCellQueries.getFullnessState(
          oPuzzle.getData(),
          randomCell
        );
        let oFullnessStateChanges = SidukoCellQueries.getFullnessStateChanges(
          oStartFullnessState,
          oEndFullnessState,
          randomCell
        );
        if (!oFullnessStateChanges) {
          oFullnessStateChanges = {};
        }
        oFullnessStateChanges.cellUsed = true;
        oFullnessStateChanges.targetCell = randomCell;
        fnGameEventCallback(oFullnessStateChanges);
        iCellsRevealed++;
      } else if (randomCell.value > 0) {
        console.warn(
          `Could not reveal random value due to existing value. (${randomCell.column},${randomCell.row}) cannot be set to ${randomCell.value}`
        );
      }
    }
    return iCellsRevealed;
  }

  // Picks a random columns and reveals the solution to all the items.
  static revealCellsWithRandomRow(
    oPuzzle,
    fnGameEventCallback,
    bonusData
  ) {
    if (typeof fnGameEventCallback !== "function") {
      throw new Error("Invalid callback function");
    }
    const emptyCells = oPuzzle.getData().cells.filter((c) => c.value === 0);
    if (emptyCells.length === 0) {
      return;
    }
    const randomRow = Math.floor(Math.random() * 9);
    //logMessage(`Random Row: ${randomRow}`, "randomChoiceStatus");
    const iMaxCells = bonusData.maxCellCount;
    let iCellsRevealed = 0;
    for (let iIndex = 0; iIndex < 9; iIndex++) {
      if (iCellsRevealed >= iMaxCells) {
        break;
      }
      const sourceCell = oPuzzle.solution.getData().cell(iIndex, randomRow);
      const targetCell = oPuzzle.getData().cell(iIndex, randomRow);
      if (
        targetCell.value <= 0 &&
        SidukoCellQueries.canSetValue(
          oPuzzle.getData(),
          targetCell,
          sourceCell.value
        )
      ) {
        const oStartFullnessState = SidukoCellQueries.getFullnessState(
          oPuzzle.getData(),
          targetCell
        );
        targetCell.value = sourceCell.value;
        targetCell.element.innerHTML = oPuzzle.charset[sourceCell.value -1];
        targetCell.setSolved();
        targetCell.element.classList.add("aided");
        targetCell.element.classList.add("granted");
        targetCell.entered = true;

        const oEndFullnessState = SidukoCellQueries.getFullnessState(
          oPuzzle.getData(),
          targetCell
        );
        let oFullnessStateChanges = SidukoCellQueries.getFullnessStateChanges(
          oStartFullnessState,
          oEndFullnessState,
          targetCell
        );
        if (!oFullnessStateChanges) {
          oFullnessStateChanges = {};
        }
        oFullnessStateChanges.cellUsed = true;
        oFullnessStateChanges.targetCell = targetCell;
        fnGameEventCallback(oFullnessStateChanges);

        iCellsRevealed++;
      } else if (targetCell.value > 0) {
        console.warn(
          `Could not reveal random row value due to existing value. (${targetCell.column},${targetCell.row}) cannot be set to ${sourceCell.value}`
        );
      }
    }
    return iCellsRevealed;
  }

  // Picks a random column and reveals the solution to all the items.
  static revealCellsWithRandomColumn(
    oPuzzle,
    fnGameEventCallback,
    bonusData
  ) {
    if (typeof fnGameEventCallback !== "function") {
      throw new Error("Invalid callback function");
    }
    const emptyCells = oPuzzle.getData().cells.filter((c) => c.value === 0);
    if (emptyCells.length === 0) {
      return;
    }
    const randomColumnn = Math.floor(Math.random() * 9);
    //logMessage(`Random Column: ${randomColumnn}`, "randomChoiceStatus");
    const iMaxCells = bonusData.maxCellCount;
    let iCellsRevealed = 0;
    for (let iIndex = 0; iIndex < 9; iIndex++) {
      if (iCellsRevealed >= iMaxCells) {
        break;
      }
      const sourceCell = oPuzzle.solution.getData().cell(randomColumnn, iIndex);
      const targetCell = oPuzzle.getData().cell(randomColumnn, iIndex);
      if (
        targetCell.value <= 0 &&
        SidukoCellQueries.canSetValue(
          oPuzzle.getData(),
          targetCell,
          sourceCell.value
        )
      ) {
        const oStartFullnessState = SidukoCellQueries.getFullnessState(
          oPuzzle.getData(),
          targetCell
        );
        fnGameEventCallback({
          cellUsed: true,
        });
        targetCell.value = sourceCell.value;
        targetCell.element.innerHTML = oPuzzle.charset[sourceCell.value -1];
        targetCell.setSolved();
        targetCell.element.classList.add("aided");
        targetCell.element.classList.add("granted");
        targetCell.entered = true;
        //SidukoHtmlGenerator.updateCellHints(oPuzzle);

        const oEndFullnessState = SidukoCellQueries.getFullnessState(
          oPuzzle.getData(),
          targetCell
        );
        let oFullnessStateChanges = SidukoCellQueries.getFullnessStateChanges(
          oStartFullnessState,
          oEndFullnessState,
          targetCell
        );
        if (!oFullnessStateChanges) {
          oFullnessStateChanges = {};
        }
        oFullnessStateChanges.cellUsed = true;
        oFullnessStateChanges.targetCell = targetCell;
        fnGameEventCallback(oFullnessStateChanges);

        iCellsRevealed++;
      } else if (targetCell.value > 0) {
        console.warn(
          `Could not reveal random column value due to existing value. (${targetCell.column},${targetCell.row}) cannot be set to ${sourceCell.value}`
        );
      }
    }
    return iCellsRevealed;
  }

  // Picks a random column and reveals the solution to all the items.
  static revealCellsWithRandomInnerTable(
    oPuzzle,
    fnGameEventCallback,
    bonusData
  ) {
    if (typeof fnGameEventCallback !== "function") {
      throw new Error("Invalid callback function");
    }
    const randomInnerTableId = Math.floor(Math.random() * 9);
    //logMessage(`Random Square: ${randomInnerTableId}`, "randomChoiceStatus");
    const emptyCells = oPuzzle
      .getData()
      .cells.filter(
        (c) => c.value === 0 && c.innerTableIndex == randomInnerTableId
      );
    if (emptyCells.length === 0) {
      return;
    }
    const iMaxCells = bonusData.maxCellCount;
    let iCellsRevealed = 0;
    emptyCells.forEach((targetCell) => {
      if (iCellsRevealed < iMaxCells) {
        const sourceCell = oPuzzle.solution.getData().cell(targetCell.column, targetCell.row);
        if (
          targetCell.value <= 0 &&
          SidukoCellQueries.canSetValue(
            oPuzzle.getData(),
            targetCell,
            sourceCell.value
          )
        ) {
          const oStartFullnessState = SidukoCellQueries.getFullnessState(
            oPuzzle.getData(),
            targetCell
          );
          targetCell.value = sourceCell.value;
          targetCell.element.innerHTML = oPuzzle.charset[sourceCell.value -1];
          targetCell.setSolved();
          targetCell.element.classList.add("aided");
          targetCell.element.classList.add("granted");
          targetCell.entered = true;

          const oEndFullnessState = SidukoCellQueries.getFullnessState(
            oPuzzle.getData(),
            targetCell
          );
          let oFullnessStateChanges = SidukoCellQueries.getFullnessStateChanges(
            oStartFullnessState,
            oEndFullnessState,
            targetCell
          );
          if (!oFullnessStateChanges) {
            oFullnessStateChanges = {};
          }
          oFullnessStateChanges.cellUsed = true;
          oFullnessStateChanges.targetCell = targetCell;
          fnGameEventCallback(oFullnessStateChanges);
          iCellsRevealed++;
        } else if (targetCell.value > 0) {
          console.warn(
            `Could not reveal random inner table value due to existing value. (${targetCell.column},${targetCell.row}) cannot be set to ${sourceCell.value}`
          );
        }
      }
    });
    return iCellsRevealed;
  }

  // Picks a random digit and then looks for all the matching cells from the solution and solves them
  static revealCellsWithRandomValue(
    oPuzzle,
    fnGameEventCallback,
    bonusData
  ) {
    if (typeof fnGameEventCallback !== "function") {
      throw new Error("Invalid callback function");
    }
    const emptyCells = oPuzzle.getData().cells.filter((c) => c.value === 0);
    if (emptyCells.length === 0) {
      return;
    }
    const randomValue = Math.floor(Math.random() * 8) + 1;
    //logMessage(`Cell Value: ${randomValue}`, "randomChoiceStatus");
    const aSourceCells = oPuzzle.solution.getData().cells.filter((c) => c.value === randomValue);
    const iMaxCells = bonusData.maxCellCount;
    let iCellsRevealed = 0;
    aSourceCells.forEach((oSourceCell) => {
      if (iCellsRevealed < iMaxCells) {
        const targetCell = oPuzzle.getData().cell(oSourceCell.column, oSourceCell.row);
        if (
          targetCell.value <= 0 &&
          SidukoCellQueries.canSetValue(
            oPuzzle.getData(),
            targetCell,
            randomValue
          )
        ) {
          const oStartFullnessState = SidukoCellQueries.getFullnessState(
            oPuzzle.getData(),
            targetCell
          );
          targetCell.value = randomValue;
          targetCell.element.innerHTML = oPuzzle.charset[randomValue -1]
          targetCell.setSolved();
          targetCell.element.classList.add("aided");
          targetCell.element.classList.add("granted");
          targetCell.entered = true;

          const oEndFullnessState = SidukoCellQueries.getFullnessState(
            oPuzzle.getData(),
            targetCell
          );
          let oFullnessStateChanges = SidukoCellQueries.getFullnessStateChanges(
            oStartFullnessState,
            oEndFullnessState,
            targetCell
          );
          if (!oFullnessStateChanges) {
            oFullnessStateChanges = {};
          }
          oFullnessStateChanges.cellUsed = true;
          oFullnessStateChanges.targetCell = targetCell;
          fnGameEventCallback(oFullnessStateChanges);
          iCellsRevealed++;
        } else if (targetCell.value > 0) {
          console.warn(
            `Could not reveal item with random value due to existing value. (${targetCell.column},${targetCell.row}) cannot be set to ${randomValue}`
          );
        }
      }
    });
    return iCellsRevealed;
  }


  static highlightCellsWithBadValues(oPuzzle, bonusData) {
    const aCells = oPuzzle.getData().cells.filter((c) => c.value > 0);
    const iMaxCells = bonusData.maxCellCount;
    let iCellsRevealed = 0;
    for(let i = 0; i < aCells.length; i++) {
      const oCell = aCells[i];
      if (oCell.value !== oPuzzle.solution.getData().cell(oCell.column, oCell.row).value) {        
        const fnAnimEnd = () => {
          oCell.element.classList.remove("badValue");
        };
        oCell.element.addEventListener("animationend", fnAnimEnd);
        oCell.element.classList.add("badValue");
        iCellsRevealed++;
        if(iCellsRevealed >= iMaxCells) {
          break;
        }
      }
    }
    return iCellsRevealed;
  }

  static canHighlightCellsWithBadValues(oPuzzle) {
    const aCells = oPuzzle.getData().cells.filter((c) => c.value > 0 && c.entered);
    let iValuesFound = 0;
    for(let i = 0; i < aCells.length; i++) {
      const oCell = aCells[i];
      if (oCell.value !== oPuzzle.solution.getData().cell(oCell.column, oCell.row).value) {        
        iValuesFound++;
      }
    }
    return iValuesFound >= SidukoConstants.MIN_BAD_CELLS_TO_ACTIVATE_HIGHLIGHT;
  }

  static hasBadValues(oPuzzle) {
    const aCells = oPuzzle.getData().cells.filter((c) => c.value > 0 && c.entered);
    for(let i = 0; i < aCells.length; i++) {
      const oCell = aCells[i];
      if (oCell.value !== oPuzzle.solution.getData().cell(oCell.column, oCell.row).value) {        
        return true;
      }
    }
    return false;
  }

  static removeCellsWithBadValues(oPuzzle, bonusData) {
    const aCells = oPuzzle.getData().cells.filter((c) => c.value > 0);
    const iMaxCells = bonusData.maxCellCount;
    let iCellsRevealed = 0;
    for(let i = 0; i < aCells.length; i++) {
      const oCell = aCells[i];
      if (oCell.value !== oPuzzle.solution.getData().cell(oCell.column, oCell.row).value) {        
        iCellsRevealed++;
        SidukoSounds.getInstance().playSound("si_eraser");
        oCell.value = 0;
       
        oCell.element.className = "";
        oCell.entered = false;       
        const fnAnimEnd = () => {
          oCell.element.classList.remove("erasing_value");
          oCell.element.innerText = "";
          oCell.element.removeEventListener("animationend", fnAnimEnd);
        };
        oCell.element.addEventListener("animationend", fnAnimEnd);
        oCell.element.classList.add("erasing_value");
        if(iCellsRevealed >= iMaxCells) {
          break;
        }
      }
    }
    return iCellsRevealed;
  }

  //Examines all the cells and looks for the cells for which only 1 value is possible, and solves them
  static autoFillCellsWithOnePossibleValue(
    oPuzzle,
    fnGameEventCallback,
    bonusData
  ) {
    if (typeof fnGameEventCallback !== "function") {
      throw new Error("Invalid callback function");
    }
    const emptyCells = oPuzzle.getData().cells.filter((c) => c.value === 0);
    if (emptyCells.length === 0) {
      return;
    }
    const iMaxCells = bonusData.maxCellCount;
    let iCellsRevealed = 0;
    emptyCells.forEach((oTargetCell) => {
      if (iCellsRevealed < iMaxCells) {
        const aPossibleValues = SidukoCellQueries.getPossibleValues(
          oPuzzle.getData(),
          oTargetCell
        );
        if (aPossibleValues.length === 1) {
          const oSourceCell = oPuzzle.solution.getData().cell(oTargetCell.column, oTargetCell.row);
          if (
            oTargetCell.value <= 0 &&
            SidukoCellQueries.canSetValue(
              oPuzzle.getData(),
              oTargetCell,
              aPossibleValues[0]
            ) &&
            oPuzzle.solution.getData().cell(oTargetCell.column, oTargetCell.row)
              .value === aPossibleValues[0]
          ) {
            const oStartFullnessState = SidukoCellQueries.getFullnessState(
              oPuzzle.getData(),
              oTargetCell
            );
            oTargetCell.value = oSourceCell.value;
            oTargetCell.element.innerHTML = oPuzzle.charset[oSourceCell.value -1]
            oTargetCell.setSolved();
            oTargetCell.element.classList.add("aided");
            oTargetCell.element.classList.add("granted");
            oTargetCell.entered = true;

            const oEndFullnessState = SidukoCellQueries.getFullnessState(
              oPuzzle.getData(),
              oTargetCell
            );
            let oFullnessStateChanges =
              SidukoCellQueries.getFullnessStateChanges(
                oStartFullnessState,
                oEndFullnessState,
                oTargetCell
              );
            if (!oFullnessStateChanges) {
              oFullnessStateChanges = {};
            }
            oFullnessStateChanges.cellUsed = true;
            oFullnessStateChanges.targetCell = oTargetCell;
            fnGameEventCallback(oFullnessStateChanges);
            iCellsRevealed++;
          } else if (oTargetCell.value > 0) {
            console.warn(
              `Could not reveal item which has only 1 target due to existing data. (${oTargetCell.column},${oTargetCell.row}) cannot be set to ${oSourceCell.value}`
            );
          }
        }
      }
    });
    return iCellsRevealed;
  }

  static canAutoFillCellsWithOnePossibleValue(oPuzzle) {
    const emptyCells = oPuzzle.getData().cells.filter((c) => c.value === 0);
    if (emptyCells.length === 0) {
      return;
    }
    let iCellsRevealed = 0;
    emptyCells.forEach((oTargetCell) => {
      if (iCellsRevealed < 1) {
        const aPossibleValues = SidukoCellQueries.getPossibleValues(
          oPuzzle.getData(),
          oTargetCell
        );
        if (aPossibleValues.length === 1) {
          if (
            oTargetCell.value <= 0 &&
            SidukoCellQueries.canSetValue(
              oPuzzle.getData(),
              oTargetCell,
              aPossibleValues[0]
            ) &&
            oPuzzle.solution.getData().cell(oTargetCell.column, oTargetCell.row)
              .value === aPossibleValues[0]
          ) {
            iCellsRevealed++;
          }
        }
      }
    });
    return iCellsRevealed > 0;
  }

  static canDoHomeRun(oPuzzle) {
    const aEmptyCells = oPuzzle.getData().cells.filter((c) => c.value <= 0);
    const aCellsWithOnePossibleValue = aEmptyCells.filter(cell => SidukoCellQueries.getPossibleValues(oPuzzle.getData(), cell).length === 1);
    if (aEmptyCells.length === aCellsWithOnePossibleValue.length) {
      return true;
    }
  }

  static async doHomeRun(oPuzzle) {
    const aEmptyCells = oPuzzle.getData().cells.filter((c) => c.value <= 0);
    const aCellsWithOnePossibleValue = aEmptyCells.filter(cell => SidukoCellQueries.getPossibleValues(oPuzzle.getData(), cell).length === 1);
    for (let i =0; i<aCellsWithOnePossibleValue.length; i++) {
      const oCell = aCellsWithOnePossibleValue[i];
      const fnAnimEnd = () => {        
        oCell.element.classList.remove("homeRun");        
        oCell.element.removeEventListener("animationend", fnAnimEnd);
        oCell.element.classList.add("aided");
        oCell.element.classList.add("gifted");
      }
      oCell.element.innerText = oPuzzle.charset[oPuzzle.solution.getData().cell(oCell.column, oCell.row).value - 1];
      oCell.element.addEventListener("animationend", fnAnimEnd);
      oCell.element.classList.add("homeRun");
      oCell.value = oPuzzle.solution.getData().cell(oCell.column, oCell.row).value;
      
      await new Promise((resolve) => setTimeout(resolve, 83));
    }
  }

  static triggerRandomBonus(oPuzzle, fnHandleGamplayChanged) {    
    const iRand = Math.floor(Math.random() * 6);
    const dummyBoost = new SidukoBoostData("", "", this);
    const iMaxCells = Math.floor(Math.random() * 2);
    dummyBoost.maxCellCount = iMaxCells;
    switch (iRand) {
      case 0:
        SidukoNotifications.getInstance().queueBonus("😍 Revealing a random cell");
        SidukoBonuses.revealRandomValue(
          oPuzzle,          
          fnHandleGamplayChanged,
          dummyBoost
        );
        break;
      case 1:
        SidukoNotifications.getInstance().queueBonus("😀 Revealing cells from a random row");
        SidukoBonuses.revealCellsWithRandomRow(
          oPuzzle,          
          fnHandleGamplayChanged,
          dummyBoost
        );
        break;
      case 2:
        SidukoNotifications.getInstance().queueBonus("🙌 Revealing cells from a random column");
        SidukoBonuses.revealCellsWithRandomColumn(
          oPuzzle,          
          fnHandleGamplayChanged,
          dummyBoost
        );
        break;
      case 3:
        SidukoNotifications.getInstance().queueBonus("💃 Revealing cells from a random inner table");
        SidukoBonuses.revealCellsWithRandomInnerTable(
          oPuzzle,
          fnHandleGamplayChanged,
          dummyBoost
        );
        break;
      case 4:
        SidukoNotifications.getInstance().queueBonus("🤗 Revealing cells which only have 1 possible value");
        SidukoBonuses.autoFillCellsWithOnePossibleValue(
          oPuzzle,          
          fnHandleGamplayChanged,
          dummyBoost
        );
        break;
      case 5:
        SidukoNotifications.getInstance().queueBonus("🤟 Revealing cells with a common random value");
        SidukoBonuses.revealCellsWithRandomValue(
          oPuzzle,
          fnHandleGamplayChanged,
          dummyBoost
        );
        break;
      default:
        console.log("Invalid bonus button click");
        break;
    }
  }
}
