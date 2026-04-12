const API = "https://wds-drycleaning-group-8.onrender.com";

/* CHECK LOGIN AND ROLE */
const token = localStorage.getItem("token");
const role = localStorage.getItem("role");

if (!token || role !== "worker") {
  window.location.href = "login.html";
}

/* LOAD ORDERS */
function loadOrders() {
  fetch(`${API}/orders`, {
    headers: { "Authorization": "Bearer " + token }
  })
    .then(res => res.json())
    .then(orders => {
      const pendingContainer = document.getElementById("pendingOrders");
      const completedContainer = document.getElementById("completedOrders");

      pendingContainer.innerHTML = "";
      completedContainer.innerHTML = "";

      if (orders.length === 0) {
        pendingContainer.innerHTML = "<p>No orders yet.</p>";
        return;
      }

      orders.forEach(order => {
        const orderBox = document.createElement("div");
        orderBox.className = "order-card";
        orderBox.innerHTML = `
          <h3>${order.customer_name}</h3>
          <p><strong>Order #:</strong> ${order.order_number}</p>
          <p><strong>Phone:</strong> ${order.customer_phone}</p>
          <p><strong>Total:</strong> $${parseFloat(order.total_cost).toFixed(2)}</p>
          <p><strong>Status:</strong> ${order.status}</p>
          <p><strong>Payment:</strong> ${order.payment_status}</p>
          <p><strong>Pickup Date:</strong> ${order.pickup_date || "Not specified"}</p>
          <p><strong>Created:</strong> ${new Date(order.created_at).toLocaleString()}</p>
        `;

        /* STATUS BUTTONS FOR PENDING ORDERS */
        if (order.status === "Pending" || order.status === "Confirmed") {
          const confirmBtn = document.createElement("button");
          confirmBtn.innerText = "Confirm";
          confirmBtn.style.marginRight = "5px";
          confirmBtn.onclick = () => updateStatus(order.order_id, "Confirmed");

          const readyBtn = document.createElement("button");
          readyBtn.innerText = "Mark Ready";
          readyBtn.style.marginRight = "5px";
          readyBtn.onclick = () => updateStatus(order.order_id, "Ready");

          const cancelBtn = document.createElement("button");
          cancelBtn.innerText = "Cancel";
          cancelBtn.style.backgroundColor = "#c0392b";
          cancelBtn.style.color = "white";
          cancelBtn.onclick = () => updateStatus(order.order_id, "Cancelled");

          orderBox.appendChild(confirmBtn);
          orderBox.appendChild(readyBtn);
          orderBox.appendChild(cancelBtn);
          pendingContainer.appendChild(orderBox);

        } else if (order.status === "Ready") {
          const pickedUpBtn = document.createElement("button");
          pickedUpBtn.innerText = "Mark Picked Up";
          pickedUpBtn.onclick = () => updateStatus(order.order_id, "Picked Up");

          orderBox.appendChild(pickedUpBtn);
          pendingContainer.appendChild(orderBox);

        } else {
          completedContainer.appendChild(orderBox);
        }
      });
    })
    .catch(() => {
      document.getElementById("pendingOrders").innerHTML = "<p>Error loading orders.</p>";
    });
}

/* UPDATE ORDER STATUS */
function updateStatus(orderId, status) {
  fetch(`${API}/orders/${orderId}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    },
    body: JSON.stringify({ status })
  })
    .then(res => res.json())
    .then(data => {
      if (data.message) {
        loadOrders();
      } else {
        alert("Failed to update status: " + (data.error || "Unknown error"));
      }
    })
    .catch(() => {
      alert("Server error. Please try again.");
    });
}

/* INITIAL LOAD */
loadOrders();

/* AUTO REFRESH EVERY 30 SECONDS */
setInterval(loadOrders, 30000);
