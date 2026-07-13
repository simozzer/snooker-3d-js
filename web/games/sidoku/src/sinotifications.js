class SidukoNotifications {
  #messageQueue
  #infoQueue
  #bonusQueue
  #alertElement
  #infoElement
  #bonusElement

  constructor() {
    this.#messageQueue = [];
    this.#infoQueue = [];
    this.#bonusQueue = [];
    this.#alertElement = document.getElementById('alert');
    this.#infoElement = document.getElementById('info');
    this.#bonusElement = document.getElementById('bonus_message');
    window.setInterval(() => this._updateAlerts(), 100);    
  }

  queueAlert(alertText, duration = 3000) {
    const oAlert = { message: alertText, duration: duration };
    this.#messageQueue.push(oAlert);
  }

  queueInfo(alertText, duration = 3000) {
    const oAlert = { message: alertText, duration: duration };
    this.#infoQueue.push(oAlert);
  }

  bonus_message

  queueBonus(alertText, duration = 3000) {
    const oAlert = { message: alertText, duration: duration };
    this.#bonusQueue.push(oAlert);
  }

  _updateAlerts() {
    if (this.#messageQueue.length > 0) {
      const oAlert = this.#messageQueue[0];
      if (new Date().getTime() - oAlert.startTime > oAlert.duration) {
        this.#messageQueue.shift();
      }
      else if (!oAlert.startTime) {
        oAlert.startTime = new Date().getTime();
        this.#alertElement.textContent = oAlert.message;
        this.#alertElement.classList.remove('hidden');

        let fnStopAlert = () => {
          this.#alertElement.classList.add('hidden');
          this.#alertElement.classList.remove('show_alert');
          this.#alertElement.innerText = '';
          this.#alertElement.removeEventListener('animationend', fnStopAlert);
          fnStopAlert = null;
        };
        this.#alertElement.addEventListener('animationend', fnStopAlert);      
        this.#alertElement.classList.add('show_alert');
      }
    }

    if (this.#infoQueue.length > 0) {
      const oInfo = this.#infoQueue[0];
      if (new Date().getTime() - oInfo.startTime > oInfo.duration) {
        this.#infoQueue.shift();
      }
      else if (!oInfo.startTime) {
        oInfo.startTime = new Date().getTime();
        this.#infoElement.textContent = oInfo.message;
        this.#infoElement.style.left = `${document.body.clientWidth - 325}px`;
        this.#infoElement.classList.remove('hidden');

        let fnStopInfo = () => {          
          this.#infoElement.classList.add('hidden');
          this.#infoElement.classList.remove('show_info'); 
          this.#infoElement.innerText = '';
          this.#infoElement.removeEventListener('animationend', fnStopInfo);
          fnStopInfo = null;
        };
        this.#infoElement.addEventListener('animationend', fnStopInfo);      

        this.#infoElement.classList.add('show_info'); 
      }
    }


    if (this.#bonusQueue.length > 0) {
      const oBonus = this.#bonusQueue[0];
      if (new Date().getTime() - oBonus.startTime > oBonus.duration) {
        this.#bonusQueue.shift();
      }
      else if (!oBonus.startTime) {
        oBonus.startTime = new Date().getTime();
        this.#bonusElement.textContent = oBonus.message;
        this.#bonusElement.style.left = `${Math.round((document.body.clientWidth - 325) / 2)}px`;
        this.#bonusElement.style.top = `750px`;
        this.#bonusElement.classList.remove('hidden');

        let fnStopBonus = () => {          
          this.#bonusElement.classList.add('hidden');
          this.#bonusElement.classList.remove('show_bonus'); 
          this.#bonusElement.innerText = '';
          this.#bonusElement.removeEventListener('animationend', fnStopBonus);
          fnStopBonus = null;
        };
        this.#bonusElement.addEventListener('animationend', fnStopBonus);      

        this.#bonusElement.classList.add('show_bonus'); 
      }
    }
  }

  static getInstance() {
    if (!this.instance) {
      this.instance = new SidukoNotifications();
    }
    return this.instance;
  }
}
