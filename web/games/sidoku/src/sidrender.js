class SidukoHtmlGenerator {
  #sidukoPuzzle;
  
  constructor(SidukoPuzzle) {
    this.#sidukoPuzzle = SidukoPuzzle;  
  }

  getPuzzleDOM() {
    const oTable = document.createElement("table");
    oTable.className =
      "sidukoTable mx-auto border-separate [border-spacing:0.25rem] border-3 bg-slate-200 rounded-2x1";
    oTable.id = "sidukoTable";
    for (let iCellY = 0; iCellY < 3; iCellY++) {
      const oTableRow = document.createElement("tr");
      for (let iCellX = 0; iCellX < 3; iCellX++) {
        const oInnerTable = this.getInnerTableDOM(iCellX, iCellY);
        oTableRow.appendChild(oInnerTable);
      }
      oTable.appendChild(oTableRow);
    }
    return oTable;
  }

  getInnerTableDOM(iTableX, iTableY) {
    const oInnerTableHolder = document.createElement("td");
    const oInnerTable = document.createElement("table");
    oInnerTable.className =
      "cell border-separate [border-spacing:0.75rem] bg-slate-400 rounded-2x1";

    for (let iInnerY = 0; iInnerY < 3; iInnerY++) {
      const oInnerRow = document.createElement("tr");
      for (let iInnerX = 0; iInnerX < 3; iInnerX++) {
        const iColumn = 3 * iTableX + iInnerX;
        const iRow = 3 * iTableY + iInnerY;
        const oInnerCell = this.getCellDOM(iColumn, iRow);
        oInnerRow.appendChild(oInnerCell);
      }
      oInnerTable.appendChild(oInnerRow);
    }

    oInnerTableHolder.appendChild(oInnerTable);
    return oInnerTableHolder;
  }

  getCellDOM(iColumn, iRow) {
    const oCellData = this.#sidukoPuzzle.getData().cell(iColumn, iRow);
    const iCellValue = oCellData.value;
    const oInnerCell = document.createElement("td");

    if (iCellValue > 0) {
      oInnerCell.innerText = this.#sidukoPuzzle.charset[iCellValue-1];
      if (oCellData.fixedValue) {
        oInnerCell.classList.add("fixedval");
      }
    } else {
      const aVals = SidukoCellQueries.getPossibleValues(
        this.#sidukoPuzzle.getData(),
        oCellData
      );
      const sVals = aVals.map(iValue => this.#sidukoPuzzle.charset[iValue - 1]);      
      oInnerCell.title = sVals.join(", ");
    }
    oInnerCell.tabIndex = 0;

    // needed for keyboard navigation
    oInnerCell.dataset.column = iColumn;
    oInnerCell.dataset.row = iRow;

    oCellData.element = oInnerCell;
    return oInnerCell;
  }

  static updateCellHints(oPuzzle) {
    // Update tooltip hints
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const oCell = oPuzzle.getData().cell(col, row);
        if (!(oCell.fixedValue || oCell.entered)) {
          const aPossibleValues = SidukoCellQueries.getPossibleValues(
            oPuzzle.getData(),
            oCell
          );
          const mappedPossibleValues = aPossibleValues.map((iValue) => oPuzzle.charset[iValue - 1]);            
          oCell.element.title = mappedPossibleValues.toString();
        } else {
          oCell.element.title = "";
        }
      }
    }
  }

  static highlightRow(oPuzzle, iRow) {
    const aCells = oPuzzle.getData().cellsInRow(iRow);
    aCells.forEach((oCell) => {
      oCell.element.classList.add("cell-highlight");
      oCell.highlightListener = oCell.element.addEventListener(
        "animationend",
        () => {
          oCell.element.removeEventListener(
            "animationend",
            oCell.highlightListener
          );
          oCell.highlightListener = null;
          oCell.element.classList.remove("cell-highlight");
        }
      );
    }, this);
  }

  static highlightColumn(oPuzzle, iColumn) {
    const aCells = oPuzzle.getData().cellsInColumn(iColumn);
    aCells.forEach((oCell) => {
      oCell.element.classList.add("cell-highlight");
      oCell.highlightListener = oCell.element.addEventListener(
        "animationend",
        () => {
          oCell.element.removeEventListener(
            "animationend",
            oCell.highlightListener
          );
          oCell.highlightListener = null;
          oCell.element.classList.remove("cell-highlight");
        }
      );
    }, this);
  }

  static highlightInnerTable(oPuzzle, iInnerTableIndex) {
    const aCells = oPuzzle.getData().cellsInInnerTable(iInnerTableIndex);
    aCells.forEach((oCell) => {
      oCell.element.classList.add("cell-highlight");
      oCell.highlightListener = oCell.element.addEventListener(
        "animationend",
        () => {
          oCell.element.removeEventListener(
            "animationend",
            oCell.highlightListener
          );
          oCell.highlightListener = null;
          oCell.element.classList.remove("cell-highlight");
        }
      );
    }, this);
  }

  static updateCharset(oPuzzle) {
    const entryPadDigitCells = Array.from(document.querySelectorAll("#cellValueEntryPopup td"));
    for(let i=0; i < 9; i++) {
      entryPadDigitCells[i].innerText = oPuzzle.charset[i];
    }
    oPuzzle.getData().cells.forEach((oCell) => {
      if (oCell.value > 0) {
        oCell.element.innerText = oPuzzle.charset[oCell.value - 1];
      }
    });
  }
}
