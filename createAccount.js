document.getElementById("createAccountForm").addEventListener("submit", function(e){

e.preventDefault();

const firstName = document.getElementById("firstName").value;
const lastName = document.getElementById("lastName").value;
const phone = document.getElementById("phone").value;
const email = document.getElementById("email").value;
const password = document.getElementById("password").value;

fetch("/createAccount",{

method:"POST",

headers:{
"Content-Type":"application/json"
},

body: JSON.stringify({
firstName,
lastName,
phone,
email,
password
})

})

.then(res => res.json())

.then(data => {

document.getElementById("accountMessage").innerText = data.message;

if(data.success){

setTimeout(()=>{
window.location.href = "login.html";
},2000);

}

});

});