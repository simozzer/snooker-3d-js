class SidukoElementEffects {

  // Create rectangular divs for each table cell and place them eaxtly over the cells.
  // fade the table out whlst animating each of the divs for implode/explode/circle, etc.

  static getElementOverlay(oElem) {
    let dup = document.createElement("div");
    dup.style.position = "absolute";
    const sourceRect = oElem.getBoundingClientRect();
    const pxRect = {
      top: parseInt(sourceRect.top,10) + "px",
      left: parseInt(sourceRect.left,10) + "px",
      width: parseInt(sourceRect.width,10) + "px",
      height: parseInt(sourceRect.height,10) + "px"
    };
    dup.style.top = pxRect.top;
    dup.style.left = pxRect.left;
    dup.style.width = pxRect.width;
    dup.style.height = pxRect.height;
    dup.style.zIndex = 1000;
    dup.innerText = oElem.innerText;
    dup.style.backgroundColor = "white"  ;
    dup.style.color = "black";  
    dup.style.textAlign = "center";
    dup.style.verticalAlign = "middle";
    dup.style.padding = "4px";
    dup.style.lineHeight = "1.8em";
    return dup;
  }

  static slideCellOut(oElem) {
    
    let dup = SidukoElementEffects.getElementOverlay(oElem);
    document.body.appendChild(dup);
  
    const fnSlideEnd = () => {
      dup.classList.add("hidden");
      dup.classList.add("remove");
      dup.removeEventListener("animationend", fnSlideEnd);
      document.body.removeChild(dup);    
      dup = null;    
    }
    dup.addEventListener("animationend", fnSlideEnd, dup);

    const animIndex = Math.floor(Math.random() * 8);
    switch (animIndex) {
      case 0:
        dup.classList.add("slide_out_top_right");
        break;
      case 1:
        dup.classList.add("slide_out_top_left");
        break;
      case 2:
        dup.classList.add("slide_out_bottom_right");
        break;
      case 3:
        dup.classList.add("slide_out_bottom_left");
        break;
      case 4:
        dup.classList.add("slide_out_mid_right");
        break;
      case 5:
        dup.classList.add("slide_out_mid_left");
        break;
      case 6:
        dup.classList.add("slide_out_mid_bottom");
        break;
      case 7:
        dup.classList.add("slide_out_mid_top");
        break;          
      default:
        console.log("Invalid animation index");
    }
  }

  static async explodeAllCells() {
    const allCells = Array.from(document.querySelectorAll(".sidukoTable table td"));
    
    for(let i=0; i < allCells.length; i++) {
      SidukoElementEffects.slideCellOut(allCells[i]);
      SidukoElementEffects.slideCellOut(allCells[allCells.length - 1 - i]);
      allCells[allCells.length - 1 - i].style.backgroundColor = "black";
      allCells[allCells.length - 1 - i].style.backgroundColor = "white";
      await new Promise(resolve => setTimeout(resolve, 35));  // simulate async operation
      allCells[i].style.backgroundColor = "white";  // reset cell background color after animation
      allCells[i].style.color = "black";  // reset cell text color after animation


    }
    
    return Promise.resolve();
  }

  static johnFucksWithYouHead() {

  }

}