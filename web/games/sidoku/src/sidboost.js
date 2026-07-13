class SidukoBoostData {
  #name;
  #maxCellCount;
  #accuracy;
  #turnsRemaining;
  #description;
  #decrementsEachTurn;
  #exhausted;
  #forSale;
  #puzzle;
  #buyHint;
  #boostBuyHint;
  #boostable;
  #cost;
  #glyph
  #passive;

  constructor(name, description, puzzle, glyph) {
    this.#name = name;
    this.#maxCellCount = 1;
    this.#accuracy = 0.3;
    this.#turnsRemaining = null;
    this.#description = description;
    this.#decrementsEachTurn = false;
    this.#exhausted = false;
    this.#forSale = false;
    this.#puzzle = puzzle;
    this.#buyHint = "";
    this.#boostable = false;
    this.#boostBuyHint = "";
    this.#cost = SidukoConstants.BOOST_LIFE_COST;
    this.#glyph = glyph;
    this.#passive = false;
  }

  get puzzle() {
    return this.#puzzle;
  }

  get name() {
    return this.#name;
  }

  get accuracy() {
    return this.#accuracy;
  }

  get description() {
    return this.#description;
  }

  get maxCellCount() {
    return this.#maxCellCount;
  }

  set maxCellCount(value) {
    this.#maxCellCount = value;
  }

  get buyHint() {
    return this.#buyHint;
  }

  set buyHint(value) {
    this.#buyHint = value;
  }

  get boostBuyHint() {
    return this.#boostBuyHint;
  }

  set boostBuyHint(value) {
    this.#boostBuyHint = value;
  }

  get boostable() {
    return this.#boostable;
  }

  set boostable(value) {
    this.#boostable = value;
  }
  
  get cost(){
    return this.#cost;
  }

  set cost(value){
    this.#cost = value;
  }

  get glyph() {
    return this.#glyph;
  }
  
  boostAccuracy() {
    if (this.accuracy < 1) {
      this.#accuracy += 0.1;
    }
  }

  boostMaxCellCount() {
    if (this.#maxCellCount < 5) {
      this.#maxCellCount += 1;
    }
  }

  get turnsRemaining() {
    return this.#turnsRemaining;
  }

  set turnsRemaining(value) {
    this.#turnsRemaining = value;
  }

  get decrementsEachTurn() {
    return this.#decrementsEachTurn;
  }

  get exhausted() {
    return this.#exhausted;
  }

  set exhausted(value) {
    this.#exhausted = value;
  }

  get forSale() {
    return this.#forSale;
  }

  set forSale(value) {
    this.#forSale = value;
  }


  getCanUse() {
    return this.#turnsRemaining > 0 && !this.exhausted;
  }

  use() {
    if (this.getCanUse()) {
      this.#turnsRemaining--;
      SidukoHtmlGenerator.updateCellHints(this.puzzle);
      return true;
    }
  }

  set decrementsEachTurn(value) {
    this.#decrementsEachTurn = value;
  }

  get passive() {
    return this.#passive;
  }

  set passive(value) {
    this.#passive = value;
  }

}

class SidukoHintsBoostData extends SidukoBoostData {
  getCanUse(playerData) {
    if (super.getCanUse()) {
      return true;
    }
    return false;
  }

  use() {
    if (this.getCanUse()) {
      this.turnsRemaining += SidukoBoostData;
      return true;
    }
    return false;
  }
}

class SidukoSeekerBoostData extends SidukoBoostData {
  getCanUse(playerData) {
    if (super.getCanUse()) {
      return SidukoBonuses.canAutoFillCellsWithOnePossibleValue(
        this.puzzle
      );
    }
    return false;
  }

  use() {
    if (this.getCanUse()) {
      if (SidukoBonuses.autoFillCellsWithOnePossibleValue(
        this.puzzle,
        () => {},
        this
      )) {
        this.turnsRemaining--;
        SidukoHtmlGenerator.updateCellHints(this.puzzle);
        return true;
      }
    }
    return false;
  }
}

class SidukoRowBoostData extends SidukoBoostData {
  use() {
    if (this.getCanUse()) {
      if (SidukoBonuses.revealCellsWithRandomRow(
        this.puzzle,
        () => {},
        this
      )) {
        this.turnsRemaining--;
        SidukoHtmlGenerator.updateCellHints(this.puzzle);
        return true;
      }
    }
    return false;
  }
}

class SidukoColumnBoostData extends SidukoBoostData {
  use() {
    if (this.getCanUse()) {
      if (SidukoBonuses.revealCellsWithRandomColumn(
        this.puzzle,
        () => {},
        this
      )) {
        this.turnsRemaining--;
        SidukoHtmlGenerator.updateCellHints(this.puzzle);
        return true;
      }
    }
    return false;
  }
}

class SidukoInnerTableBoostData extends SidukoBoostData {
  use() {
    if (this.getCanUse()) {
      if (SidukoBonuses.revealCellsWithRandomInnerTable(
        this.puzzle,
        () => {},
        this
      )) {
        this.turnsRemaining--;
        SidukoHtmlGenerator.updateCellHints(this.puzzle);
        return true;
      }
    }
    return false;
  }
}

class SidukoRandomBoostData extends SidukoBoostData {
  use() {
    if (this.getCanUse()) {
      if (SidukoBonuses.revealRandomValue(
        this.puzzle,
        () => {},
        this
      )) {
        this.turnsRemaining--;
        SidukoHtmlGenerator.updateCellHints(this.puzzle);
        return true;
      }
    }
    return false;
  }
}

class SidukoRandomValueBoostData extends SidukoBoostData {
  use() {
    if (this.getCanUse()) {
      if (SidukoBonuses.revealCellsWithRandomValue(
        this.puzzle,
        () => {},
        this
      )) {;
        this.turnsRemaining--;
        SidukoHtmlGenerator.updateCellHints(this.puzzle);
        return true;
      }
    }
    return false;
  }
}

class SidukoHighlightBoostData extends SidukoBoostData {

  getCanUse(playerData) {
    if (super.getCanUse()) {      
      return SidukoBonuses.canHighlightCellsWithBadValues(
        this.puzzle
      );
    }
    return false;
  }
  use() {
    if (this.getCanUse()) {
      SidukoBonuses.highlightCellsWithBadValues(this.puzzle, this);
      this.turnsRemaining--;
      return true;
    }    
    return false;
  }
}

class SidukoBadValueRemovalBoostData extends SidukoBoostData {

  getCanUse(playerData) {
    if (super.getCanUse()) {      
      return SidukoBonuses.hasBadValues(
        this.puzzle
      );
    }
    return false;
  }
  use() {
    if (this.getCanUse()) {
      SidukoBonuses.removeCellsWithBadValues(this.puzzle, this);
      this.turnsRemaining--;
      SidukoHtmlGenerator.updateCellHints(this.puzzle);
      return true;
    }    
    return false;
  }
}

class SidukoHomeRunBoostData extends SidukoBoostData {
  getCanUse() {    
      return SidukoBonuses.canDoHomeRun(this.puzzle);
  }

  async use() {
    if (this.getCanUse()) {
      await SidukoBonuses.doHomeRun(this.puzzle, this);
      return true;
    }    
    return false;
  }
}


