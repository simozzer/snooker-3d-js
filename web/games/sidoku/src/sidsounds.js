class SidukoSounds {
  #cachedSounds
  constructor() {
    this.#cachedSounds = [];
    this.#getSound("Click1", 0.8);
    this.#getSound("hiss1", 0.4);
    this.#getSound("all systems go", 0.2);
    this.#getSound("swipe_9", 0.2);
    this.#getSound("si_lost_bonus", 0.4);
    this.#getSound("si_lost_hints", 0.4);
    this.#getSound("si_incorrect_row", 0.4);
    this.#getSound("si_correct_row", 0.6);
    this.#getSound("si_bonus_exhausted", 0.6);
    this.#getSound("si_eraser",0.4);
  }

  playSound(sSoundName) {
    this.#getSound(sSoundName).play();
  }

  #getSound(sSoundName, volume) {
    let oSound = this.#cachedSounds.find(
      (s) => s.name.toLowerCase() === sSoundName.toLowerCase()
    );
    if (!oSound) {
      const oAudio = new Audio(`./resources/sounds/${sSoundName}.wav`);
      oAudio.volume = volume;
      oSound = { name: sSoundName, sound: oAudio };
      this.#cachedSounds.push(oSound);
    }
    return oSound.sound;
  }

  static getInstance() {
    if (!this.instance) {
      this.instance = new SidukoSounds();
    }
    return this.instance;
  }
}

