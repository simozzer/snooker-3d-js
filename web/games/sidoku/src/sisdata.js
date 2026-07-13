const cellValueStates = {
  FIXED: 1,
  ENTERED: 2,
  SUGGESTED: 3,
  SOLVED: 4,
};
Object.freeze(cellValueStates);

class SidukoPuzzleData {
  #cells;
  #rowCells = [];
  #columnCells = [];
  #innerTableCells = [];
  constructor() {
    this.#cells = [];
    for (let iCellIndex = 0; iCellIndex < 81; iCellIndex++) {
      const oCell = new SidukoCell(iCellIndex);
      this.#cells.push(oCell);
    }

    // Optimisation. Build a collection of the cells in each column, row and inner table
    for (let i = 0; i < 9; i++) {
      this.#rowCells[i] = this.#cells.filter(
        (oCell) => oCell.row === i && oCell.fixedValue === false
      );
      this.#columnCells[i] = this.#cells.filter(
        (oCell) => oCell.column === i && oCell.fixedValue === false
      );
      this.#innerTableCells[i] = this.#cells.filter(
        (oCell) => oCell.innerTableIndex === i && oCell.fixedValue === false
      );
    }
  }

  get cells() {
    return this.#cells;
  }
  set cells(value) {
    this.#cells = value;
  }

  cell(iColIndex, iRowIndex) {
    return this.#rowCells[iRowIndex][iColIndex];
  }

  cellsInRow(iRowIndex) {
    return this.#rowCells[iRowIndex];
  }

  cellsInColumn(iColumnIndex) {
    return this.#columnCells[iColumnIndex];
  }

  cellsInInnerTable(iInnerTableIndex) {
    return this.#innerTableCells[iInnerTableIndex];
  }
}

class SidukoCell {
  #column;
  #row;
  #value;
  #innerTableIndex;
  #valueState;
  #element;
  #passIndex;
  #bonusTrigger;
  #randomBonusTrigger;

  constructor(iCellIndex) {
    this.#row = Math.floor(iCellIndex / 9);
    this.#column = iCellIndex - 9 * this.#row;
    this.#innerTableIndex =
      3 * Math.floor(this.#row / 3) + Math.floor(this.#column / 3);
    this.#value = 0;
    this.choiceIndex = 0;
    this.#passIndex = -1;
    this.#bonusTrigger = false;
    this.#randomBonusTrigger = false;
  }

  get innerTableIndex() {
    return this.#innerTableIndex;
  }

  get column() {
    return this.#column;
  }

  get row() {
    return this.#row;
  }

  get value() {
    return this.#value;
  }

  set value(iValue) {
    this.#value = iValue;
  }

  get passIndex() {
    return this.#passIndex;
  }

  set passIndex(iPassIndex) {
    this.#passIndex = iPassIndex;
  }

  setEmptyValue() {
    this.#valueState = undefined;
  }

  setFixedValue() {
    this.#valueState = cellValueStates.FIXED;
  }

  get fixedValue() {
    return this.#valueState === cellValueStates.FIXED;
  }

  get entered() {
    return this.#valueState === cellValueStates.ENTERED;
  }

  set entered(bEntered) {
    if (bEntered) {
      this.#valueState = cellValueStates.ENTERED;
    } else if (
      [cellValueStates.SOLVED, cellValueStates.FIXED].indexOf(
        this.#valueState
      ) < 0
    ) {
      this.#valueState = undefined;
    }
  }

  get solved() {
    return this.#valueState === cellValueStates.SOLVED;
  }

  setSolved() {
    this.#valueState = cellValueStates.SOLVED;
  }

  get suggested() {
    return this.#valueState === cellValueStates.SUGGESTED;
  }

  set suggested(bSuggested) {
    this.#valueState = bSuggested ? cellValueStates.SUGGESTED : undefined;
  }

  get element() {
    return this.#element;
  }

  set element(element) {
    this.#element = element;
  }

  get bonusTrigger() {
    return this.#bonusTrigger;
  }

  set bonusTrigger(bBonusTrigger) {
    this.#bonusTrigger = bBonusTrigger;
  }

  get randomBonusTrigger() {
    return this.#randomBonusTrigger;
  }

  set randomBonusTrigger(b) {
    this.#randomBonusTrigger = b;
  }

  reset() {
    this.#value = 0;
    this.#valueState = undefined;
  }
}
