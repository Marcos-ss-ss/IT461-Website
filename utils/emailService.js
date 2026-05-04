import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 1. Customer pickup email
export async function sendPickupEmail(toEmail, customerName) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: toEmail,
    subject: 'Your Order is Ready for Pickup!',
    text: `Hi ${customerName}, your dry cleaning order is ready for pickup.`,
  });
}

// 2. Vendor order email
export async function sendVendorOrderEmail(vendorEmail, orderDetails) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: vendorEmail,
    subject: 'New Vendor Order',
    text: `New order placed:\n\n${orderDetails}`,
  });
}

// 3. Revenue report email
export async function sendRevenueReport(reportText) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: 'washingwds@gmail.com, wds.drycleaning@gmail.com',
    subject: 'Revenue Report',
    text: reportText,
  });
}
