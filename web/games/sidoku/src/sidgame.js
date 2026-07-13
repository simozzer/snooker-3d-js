doGameLoaded = () => {
  document
    .getElementById("menu")
    .addEventListener("change", doMenuChanged.bind(this));

    const oActiveElem = document.querySelector("#charset_menu a.active_charset");
    if (oActiveElem) {
      oActiveElem.classList.remove("active_charset");
    }

    const urlParams = new URLSearchParams(window.location.search);
    const charsetVal = urlParams.get('charset');
    const attributeVal = "?charset=" + charsetVal;
    const elem = document.querySelector(`#charset_menu a[href="${attributeVal}"]`);
    if (elem) {
      elem.classList.add("active_charset");
    }    
};

loadPuzzle = (filename) => {
  fetch(filename)
    .then((res) => res.text())
    .then((text) => {
      // do something with "text"
      const lines = text.split("\n");
      const lineNum = Math.floor(Math.random() * lines.length);
      const puzzleData = lines[lineNum];      
      setupGame(puzzleData);
    })
    .catch((e) => console.error(e));
};

doMenuChanged = (oEv) => {
  switch (oEv.target.value) {
    case "Easy":
      // oEv.target.disabled = true;
      //setupPuzzle(escargotAiData);
      SidukoNotifications.getInstance().queueAlert(`There could be a short delay whilst the data is downloaded and checked`, 3000); 
      loadPuzzle("./resources/easyPuzzleData.txt");
      oEv.target.display = "none";
      break;

    case "Medium":
      //oEv.target.disabled = true;
      SidukoNotifications.getInstance().queueAlert(`There could be a short delay whilst the data is downloaded and checked`, 3000); 
      loadPuzzle("./resources/mediumPuzzleData.txt");
      oEv.target.display = "none";
      break;
    case "Hard":
      // oEv.target.disabled = true;
      SidukoNotifications.getInstance().queueAlert(`There could be a short delay whilst the data is downloaded and checked`, 3000); 
      loadPuzzle("./resources/hardPuzzleData.txt");
      oEv.target.display = "none";
      break;
    case "Diabolical":
      //oEv.target.disabled = true;
      SidukoNotifications.getInstance().queueAlert(`There could be a short delay whilst the data is downloaded and checked`, 3000); 
      loadPuzzle("./resources/diabolicalPuzzleData.txt");
      oEv.target.display = "none";
      break;
    default:
      break;
  }
};
/**
 * Initializes the game with starting data.
 *
 * @param {Object} oGame - The game object to be initialized.
 * @param {Array<string>} aStartData - An array of strings representing the initial values for each cell.
 *                                     Each string should be a single digit or '0' for empty cells.
 * @returns {void}
 */

messageBufferTimeout = null;
oMessageTimeout = null;
oMessageElement = null;
aMessages = [];
function logMessage(message, className = "") {
  if (!message) {
    return;
  }
  console.log(message);
  aMessages.push({ message: message, className: className });

  showMessages();
}

function __displayMessage(message) {
  if (message) {
    if (!oMessageElement) {
      oMessageElement = document.getElementById("messageBox");
    }

    if (!oMessageElement) {
      oMessageElement = document.createElement("div");
      oMessageElement.id = "messageBox";
      oMessageElement.classList.add("messageBox");
      document.getElementById("everywhere").appendChild(oMessageElement);

      oMessageElement.addEventListener("animationend", function () {
        if (oMessageElement.classList.contains("initial")) {
          oMessageElement.classList.remove("initial");
          oMessageElement.style.display = "none";
          oMessageElement.innerText = "";
        }
      });
    }

    oMessageElement.innerText = message;
    oMessageElement.style.display = "block";

    
    let fnTimeout = window.setTimeout(() => {
      oMessageElement.classList.add("initial");
      window.clearTimeout(fnTimeout);
      fnTimeout = null;
    }, 2300);
    
  }
}

function showMessages() {
  if (!messageBufferTimeout) {
    messageBufferTimeout = window.setInterval(
      () => {
        if (aMessages.length > 0) {
          const oMessage = aMessages[0];
          if (typeof oMessage.startTime === "undefined") {
            oMessage.startTime = Date.now();
            this.__displayMessage(oMessage.message, oMessage.className);
          } else if (Date.now() > oMessage.startTime + 3800) {
              aMessages.shift();
          }
        }
      },
      20,
      this
    );
  }
}

function addLogSeperator() {
  const hr = document.createElement("hr");
  document.getElementById("messageList").appendChild(hr);
}

oMaster = null;
function setupGame(puzzleData) {
  if (messageBufferTimeout) {
    window.clearInterval(messageBufferTimeout);
    messageBufferTimeout = null;
  }
  if (oMessageTimeout) {
    window.clearTimeout(oMessageTimeout);
    oMessageTimeout = null;
  }
  oMessageElement = null;

  if (oMaster) {
    oMaster.stop();
    oMaster = null;
  }

  oMaster = new SidukoMain(puzzleData);
  oMaster.start();
}
