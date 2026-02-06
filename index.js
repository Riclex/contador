import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post("/webhook", (req, res) => {
  console.log("Incoming Twilio payload:");
  console.log(req.body);
  res.send("ok");
});

app.get("/health", (_, res) => {
  res.send("ok");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
