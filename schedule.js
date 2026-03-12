const steps = document.querySelectorAll(".step");
const nextBtns = document.querySelectorAll(".next-btn");

let currentStep = 0;

/* STORAGE FOR ITEMS */
let laundryItems = [];

/* PRICING TABLE */
const prices = {
    "Pants": 4,
    "Long Sleeve Shirt": 3,
    "Short Sleeve Shirt": 3,
    "Dress": 8,
    "Jacket": 6,
    "Sweater": 5
};

/* ELEMENT REFERENCES */
const addItemBtn = document.getElementById("addItem");
const itemList = document.getElementById("itemList");

const clothingTypeInput = document.getElementById("clothingType");
const quantityInput = document.getElementById("quantity");
const pricePreview = document.getElementById("pricePreview");

/* LIVE PRICE PREVIEW */
function updatePricePreview() {

    const type = clothingTypeInput.value;
    const quantity = parseInt(quantityInput.value);

    if (!type || !quantity) {
        pricePreview.textContent = "";
        return;
    }

    const price = prices[type] || 0;
    const total = price * quantity;

    pricePreview.textContent = "Item Price: $" + price + " | Estimated Cost: $" + total;
}

clothingTypeInput.addEventListener("change", updatePricePreview);
quantityInput.addEventListener("input", updatePricePreview);

/* ADD ITEM */
addItemBtn.addEventListener("click", function () {

    const type = clothingTypeInput.value;
    const owner = document.getElementById("clothingOwner").value;
    const quantity = document.getElementById("quantity").value;

    if (type === "" || owner === "" || quantity === "") {
        alert("Please select clothing type, owner, and quantity.");
        return;
    }

    const itemText = quantity + " " + owner + " " + type;

    laundryItems.push({
        text: itemText,
        type: type,
        quantity: parseInt(quantity)
    });

    const li = document.createElement("li");
    li.textContent = itemText + " ";

    /* REMOVE BUTTON */
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.style.marginLeft = "10px";

    removeBtn.onclick = function () {

        itemList.removeChild(li);

        laundryItems = laundryItems.filter(item => item.text !== itemText);

    };

    li.appendChild(removeBtn);
    itemList.appendChild(li);

    /* CLEAR INPUTS */
    clothingTypeInput.value = "";
    document.getElementById("clothingOwner").value = "";
    quantityInput.value = "";
    pricePreview.textContent = "";
});

/* NEXT BUTTON LOGIC + VALIDATION */
nextBtns.forEach(btn => {

    btn.addEventListener("click", () => {

        const inputs = steps[currentStep].querySelectorAll("input, select");

        for (let input of inputs) {

            if (input.value.trim() === "") {

                if (currentStep === 3 && laundryItems.length > 0) {
                    break;
                }

                alert("Please answer this question before continuing.");
                return;
            }

            /* PHONE VALIDATION */
            if (input.id === "phone") {

                const phonePattern = /^\d{10}$/;

                if (!phonePattern.test(input.value)) {
                    alert("Please enter a valid 10-digit phone number.");
                    return;
                }
            }
        }

        steps[currentStep].classList.remove("active");
        currentStep++;

        if (currentStep < steps.length) {
            steps[currentStep].classList.add("active");
        }

    });

});

/* FORM SUBMISSION */
document.getElementById("laundryForm").addEventListener("submit", function (e) {

    e.preventDefault();

    if (laundryItems.length === 0) {
        alert("Please add at least one clothing item.");
        return;
    }

    const orderNumber = "WDS-" + Math.floor(Math.random() * 100000);

    const firstName = document.getElementById("firstName").value;
    const lastName = document.getElementById("lastName").value;
    const phone = document.getElementById("phone").value;
    const laundryType = document.getElementById("laundryType").value;
    const instructions = document.getElementById("instructions").value;

    let itemsHTML = "";
    let total = 0;
    let totalItems = 0;

    laundryItems.forEach(item => {

        const price = prices[item.type] || 0;
        const itemCost = price * item.quantity;

        total += itemCost;
        totalItems += item.quantity;

        itemsHTML += "<li>" + item.text + " - $" + itemCost + "</li>";

    });

    document.getElementById("laundryForm").style.display = "none";

    const receipt = document.getElementById("receipt");
    receipt.style.display = "block";

    receipt.innerHTML = `
        <h2>Order Confirmed</h2>

        <p><strong>Order Number:</strong> ${orderNumber}</p>
        <p><strong>Name:</strong> ${firstName} ${lastName}</p>
        <p><strong>Phone:</strong> ${phone}</p>
        <p><strong>Service:</strong> ${laundryType}</p>

        <p><strong>Items:</strong></p>
        <ul>${itemsHTML}</ul>

        <p><strong>Total Pieces:</strong> ${totalItems}</p>
        <p><strong>Total Cost:</strong> $${total}</p>

        <p><strong>Instructions:</strong> ${instructions}</p>

        <p class="note">
        Please show this order number when dropping off your laundry.
        </p>

        <button class="home-btn" onclick="window.location.href='MainPage.html'">
        Return to Home
        </button>
    `;
});