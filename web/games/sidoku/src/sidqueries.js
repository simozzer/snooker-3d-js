class SidukoCellQueries {
  /**
   * Determines the possible values for a given cell in a Sudoku grid.
   *
   * @param {Object} oSudukoData - The Sudoku data object containing information about the current state of the grid.
   * @param {Object} oCell - The cell object for which possible values are being determined.
   * @returns {number[]} An array of possible values for the given cell, based on Sudoku rules.
   */
  static getPossibleValues(oSudukoData, oCell) {
    const possibleValues = [];
    const { row, column, innerTableIndex } = oCell;

    // count backwards (for most processors the comparison to zero at the end of the loop will be faster)
    for (let value = 9; value > 0; value--) {
      if (
        !oSudukoData.cellsInRow(row).some((cell) => cell.value == value) &&
        !oSudukoData
          .cellsInColumn(column)
          .some((cell) => cell.value == value) &&
        !oSudukoData
          .cellsInInnerTable(innerTableIndex)
          .some((cell) => cell.value == value)
      ) {
        possibleValues.push(value);
      }
    }
    return possibleValues;
  }

  /**
   * Checks if a specific value can be set in a given cell without violating Sudoku rules.
   *
   * @param {Object} oSudukoData - The Sudoku data object containing information about the current state of the grid.
   * @param {Object} oCell - The cell object where the value is being checked.
   * @param {number} value - The value to be checked for placement in the cell.
   * @returns {boolean} True if the value can be set in the cell without conflicts, false otherwise.
   */
  static canSetValue(oSudukoData, oCell, value) {
    const { row, column, innerTableIndex } = oCell;
    return (
      !oSudukoData.cellsInRow(row).some((cell) => cell.value == value) &&
      !oSudukoData.cellsInColumn(column).some((cell) => cell.value == value) &&
      !oSudukoData
        .cellsInInnerTable(innerTableIndex)
        .some((cell) => cell.value == value)
    );
  }

  /**
   * Determines if a cell can be set with a valid value based on the current state of the Sudoku grid.
   *
   * @param {Object} oSudukoData - The Sudoku data object containing information about the current state of the grid.
   * @param {Object} oCell - The cell object for which the value is being checked.
   * @returns {boolean} True if a valid value can be set for the cell, false otherwise.
   */
  static canSetACellValue(oSudukoData, oCell) {
    const possibleCellValues = this.getPossibleValues(oSudukoData, oCell);
    let choiceIndex = oCell.choiceIndex;
    const possibleValueCount = possibleCellValues.length;
    while (choiceIndex < possibleValueCount) {
      if (
        this.canSetValue(oSudukoData, oCell, possibleCellValues[choiceIndex])
      ) {
        oCell.choiceIndex = choiceIndex;
        return true;
      }
      choiceIndex++;
    }
    return false;
  }

  static getValuesWhichOccurInASingleCell(
    oSudkoData,
    fnGetCellItem,
    passIndex,
    cellStack
  ) {
    if (typeof fnGetCellItem !== "function") {
      throw new Error("fnGetCellItem must be a function");
    }

    let bUpdated = false;

    for (let iColIndex = 0; iColIndex < 9; iColIndex++) {
      if (bUpdated) break;
      const cellsToCheck = fnGetCellItem(iColIndex);
      const filteredCells = cellsToCheck.filter((cell) => cell.value <= 0);

      for (let digit = 1; digit < 10; digit++) {
        filteredCells.forEach((oCell) => {
          const aPossibleCellValues = this.getPossibleValues(oSudkoData, oCell);
          const singleChanceCells = aPossibleCellValues.filter(
            (i) => i === digit
          );
          if (singleChanceCells && singleChanceCells.length === 1) {
            bUpdated = true;
            oCell.choiceIndex = aPossibleCellValues.indexOf(digit);
            oCell.value = digit;
            oCell.setSolved();
            oCell.passIndex = passIndex;
            cellStack.push(oCell);
          }
        });
      }
      if (bUpdated) {
        break;
      }
    }
    return bUpdated;
  }

  static getIsRowFull(oSidukoData, row) {
    return oSidukoData.cellsInRow(row).every((cell) => cell.value > 0);
  }

  static getColumnIsFull(oSidukoData, column) {
    return oSidukoData.cellsInColumn(column).every((cell) => cell.value > 0);
  }

  static getInnerTableIsFull(oSidukoData, innerTableIndex) {
    return oSidukoData
      .cellsInInnerTable(innerTableIndex)
      .every((cell) => cell.value > 0);
  }

  static getFullnessState(oSidukoData, oCell) {
    return {
      row: this.getIsRowFull(oSidukoData, oCell.row),
      column: this.getColumnIsFull(oSidukoData, oCell.column),
      innerTableIndex: this.getInnerTableIsFull(
        oSidukoData,
        oCell.innerTableIndex
      ),
      board: oSidukoData.cells.every((cell) => cell.value > 0),
    };
  }

  static getFullnessStateChanges(
    oStartFullnessState,
    oEndFullnessState,
    oCellData
  ) {
    let oFullnessStateChanges = null;
    if (oStartFullnessState.column !== oEndFullnessState.column) {
      if (oFullnessStateChanges === null) {
        oFullnessStateChanges = {};
      }
      oFullnessStateChanges["column"] = oCellData.column + 1;
    }
    if (oStartFullnessState.row !== oEndFullnessState.row) {
      if (oFullnessStateChanges === null) {
        oFullnessStateChanges = {};
      }
      oFullnessStateChanges["row"] = oCellData.row + 1;
    }
    if (
      oStartFullnessState.innerTableIndex !== oEndFullnessState.innerTableIndex
    ) {
      if (oFullnessStateChanges === null) {
        oFullnessStateChanges = {};
      }
      oFullnessStateChanges["innerTable"] = oCellData.innerTableIndex + 1;
    }
    if (oStartFullnessState.board !== oEndFullnessState.board) {
      if (oFullnessStateChanges === null) {
        oFullnessStateChanges = {};
      }
      oFullnessStateChanges["board"] = true;
    }
    return oFullnessStateChanges;
  }
}
