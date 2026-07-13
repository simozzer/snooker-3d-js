

class SidukoPuzzle {
  #rowCells = [];
  #columnCells = [];
  #innerTableCells = [];
  #data = new SidukoPuzzleData();
  #solution = null;
  #charset;

  #history = [];
  constructor() {
    this.#data = new SidukoPuzzleData();

    // Optimisation. Build a collection of the cells in each column, row and inner table
    for (let i = 0; i < 9; i++) {
      this.#rowCells[i] = this.#data.cells.filter((oCell) => oCell.row === i);
      this.#columnCells[i] = this.#data.cells.filter(
        (oCell) => oCell.column === i
      );
      this.#innerTableCells[i] = this.#data.cells.filter(
        (oCell) => oCell.innerTableIndex === i
      );
    }

    const urlParams = new URLSearchParams(window.location.search);
    const charsetVal = urlParams.get('charset');
  

    //https://www.vertex42.com/ExcelTips/unicode-symbols.html#currency
    switch (charsetVal) {
      case "alpha":
        this.charset = [...SidukoConstants.ALPHA_SET];
        break;
      case "emoji":
        this.charset = [...SidukoConstants.EMOJI_SET];
        break;
      case "roman":
        this.charset = [...SidukoConstants.ROMAN_SET];
        break;
      case "color":
        this.charset = [...SidukoConstants.COLOR_SET];
        break;
      case "fractions":
        this.charset = [...SidukoConstants.FRACTIONS_SET];
        break;      
      case "arrows":
        this.charset = [...SidukoConstants.ARROWS_SET];
        break;  
      case "numcircles":
        this.charset = [...SidukoConstants.NUMBER_CIRCLES_SET];
        break;
      case "braille":
        this.charset = [...SidukoConstants.BRAILLE_SET];
        break;  
      case "spelling":
        this.charset = [...SidukoConstants.COMMON_LETTERS_SET];
        break;  
      default:
        this.charset = [...SidukoConstants.NUM_SET];
        break;
    }
    
  }

  set solution(value) {
    this.#solution = value;
  }

  get solution() {
    return this.#solution;
  }

  setPuzzleStartData(aStartData) {
    aStartData.forEach((iValue, iIndex) => {
      const oCell = this.getData().cells[iIndex];
      if (iValue > 0) {
        oCell.value = iValue;
        oCell.setFixedValue();
      }
    });
  }

  getData() {
    return this.#data;
  }

  get charset() {
    return this.#charset;
  }

  set charset(sCharset) {
    this.#charset = [...sCharset];
  }

  getHistory() {
    return this.#history;
  }

}
