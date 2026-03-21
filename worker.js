function loadOrders(){

fetch("/getOrders")

.then(res => res.json())

.then(data => {

const pendingContainer = document.getElementById("pendingOrders");
const completedContainer = document.getElementById("completedOrders");

pendingContainer.innerHTML = "";
completedContainer.innerHTML = "";

data.forEach(order => {

const orderBox = document.createElement("div");

orderBox.className = "order-card";

orderBox.innerHTML = `
<h3>${order.first_name} ${order.last_name}</h3>

<p><strong>Phone:</strong> ${order.phone}</p>

<p><strong>Service:</strong> ${order.service}</p>

<p><strong>Total:</strong> $${order.total_cost}</p>

<p><strong>Status:</strong> ${order.status}</p>
`;


/* PENDING ORDERS */

if(order.status === "Pending"){

const button = document.createElement("button");

button.innerText = "Mark Complete";

button.onclick = () => completeOrder(order.id);

orderBox.appendChild(button);

pendingContainer.appendChild(orderBox);

}

/* COMPLETED ORDERS */

else{

completedContainer.appendChild(orderBox);

}

});

});

}


/* COMPLETE ORDER */

function completeOrder(orderId){

fetch("/completeOrder",{

method:"POST",

headers:{
"Content-Type":"application/json"
},

body: JSON.stringify({
orderId: orderId
})

})

.then(res => res.json())

.then(data => {

if(data.success){

loadOrders();

}

});

}


/* INITIAL LOAD */

loadOrders();


/* AUTO REFRESH */

setInterval(loadOrders,5000);