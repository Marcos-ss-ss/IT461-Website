const API = "https://wds-drycleaning-group-8.onrender.com";

/* CHECK LOGIN */
const token = localStorage.getItem("token");
if (!token) {
  window.location.href = "login.html";
}

const steps = document.querySelectorAll(".step");
const nextBtns = document.querySelectorAll(".next-btn");

let currentStep = 0;
let laundryItems = [];
let servicesMap = {}; // service_name -> { id, price }

/* ELEMENT REFERENCES */
const addItemBtn = document.getElementById("addItem");
const itemList = document.getElementById("itemList");
const clothingTypeInput = document.getElementById("clothingType");
const quantityInput = document.getElementById("quantity");
const pricePreview = document.getElementById("pricePreview");

/* LOAD SERVICES FROM API */
fetch(`${API}/services`)
  .then(res => res.json())
  .then(services => {
    servicesMap = {};
    clothingTypeInput.innerHTML = '<option value="">Select type</option>';

    services.forEach(svc => {
      servicesMap[svc.service_name] = { id: svc.id, price: parseFloat(svc.price) };
      const option = document.createElement("option");
      option.value = svc.service_name;
      option.textContent = svc.service_name + " - $" + parseFloat(svc.price).toFixed(2);
      clothingTypeInput.appendChild(option);
    });
  })
  .catch(() => {
    alert("Could not load services. Please refresh the page.");
  });

/* LIVE PRICE PREVIEW */
function updatePricePreview() {
  const type = clothingTypeInput.value;
  const quantity = parseInt(quantityInput.value);

  if (!type || !quantity) {
    pricePreview.textContent = "";
    return;
  }

  const svc = servicesMap[type];
  if (!svc) return;

  const total = svc.price * quantity;
  pricePreview.textContent = "Item Price: $" + svc.price.toFixed(2) + " | Estimated Cost: $" + total.toFixed(2);
}

clothingTypeInput.addEventListener("change", updatePricePreview);
quantityInput.addEventListener("input", updatePricePreview);

/* ADD ITEM */
addItemBtn.addEventListener("click", function () {
  const type = clothingTypeInput.value;
  const quantity = parseInt(quantityInput.value);

  if (!type || !quantity) {
    alert("Please select a service and quantity.");
    return;
  }

  const svc = servicesMap[type];
  const lineTotal = svc.price * quantity;
  const itemText = quantity + "x " + type + " - $" + lineTotal.toFixed(2);

  laundryItems.push({
    text: itemText,
    service_id: svc.id,
    quantity: quantity
  });

  const li = document.createElement("li");
  li.textContent = itemText + " ";

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "Remove";
  removeBtn.style.marginLeft = "10px";
  removeBtn.onclick = function () {
    itemList.removeChild(li);
    laundryItems = laundryItems.filter(item => item.text !== itemText);
  };

  li.appendChild(removeBtn);
  itemList.appendChild(li);

  clothingTypeInput.value = "";
  quantityInput.value = "";
  pricePreview.textContent = "";
});

/* NEXT BUTTON LOGIC */
nextBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const inputs = steps[currentStep].querySelectorAll("input, select");

    for (let input of inputs) {
      if (input.value.trim() === "") {
        if (currentStep === 3 && laundryItems.length > 0) break;
        alert("Please answer this question before continuing.");
        return;
      }

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
    alert("Please add at least one item.");
    return;
  }

  const pickup_date = document.getElementById("pickupDate") ? document.getElementById("pickupDate").value : null;
  const pickup_time = document.getElementById("pickupTime") ? document.getElementById("pickupTime").value : null;
  const special_notes = document.getElementById("instructions") ? document.getElementById("instructions").value : null;

  const items = laundryItems.map(item => ({
    service_id: item.service_id,
    quantity: item.quantity
  }));

  fetch(`${API}/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    },
    body: JSON.stringify({ pickup_date, pickup_time, special_notes, items })
  })
    .then(res => res.json())
    .then(data => {
      if (data.order_number) {
        document.getElementById("laundryForm").style.display = "none";

        const receipt = document.getElementById("receipt");
        receipt.style.display = "block";

        let itemsHTML = "";
        laundryItems.forEach(item => { itemsHTML += "<li>" + item.text + "</li>"; });

        receipt.innerHTML = `
          <h2>Order Confirmed ✅</h2>
          <p><strong>Order Number:</strong> ${data.order_number}</p>
          <p><strong>Items:</strong></p>
          <ul>${itemsHTML}</ul>
          <p><strong>Total Cost:</strong> $${parseFloat(data.total_cost).toFixed(2)}</p>
          <p class="note">Please show this order number when dropping off your laundry.</p>
          <button class="home-btn" onclick="window.location.href='index.html'">Return to Home</button>
        `;
      } else {
        alert(data.error || "Order failed. Please try again.");
      }
    })
    .catch(() => {
      alert("Server error. Please try again.");
    });
});
