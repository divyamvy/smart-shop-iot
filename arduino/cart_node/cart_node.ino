// ============================
// CART NODE
// ============================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ============================
// WIFI
// ============================
const char* ssid     = "Piyush";
const char* password = "112233445566";

// ============================
// HIVEMQ CLOUD
// ============================
const char* mqtt_server   = "fa5e66fc548146f783420bef085c1154.s1.eu.hivemq.cloud";
const char* mqtt_username = "smartshop";
const char* mqtt_password = "Smartshop123";

// ============================
// HARDWARE
// ============================
WiFiClientSecure  espClient;
PubSubClient      client(espClient);
LiquidCrystal_I2C lcd(0x27, 16, 2);

#define BASKET_FS 2

// ============================
// STATE
// ============================
int  total          = 0;
int  prevBasketSent = -999;  // force publish on first loop
bool showingBill    = false;

// ============================
// HELPERS
// ============================
void lcdMsg(const char* line0, const char* line1 = "") {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(line0);
  lcd.setCursor(0, 1); lcd.print(line1);
}

void showIdle() {
  lcdMsg("SMART CART", "Waiting...");
}

void showTotal() {
  if (!showingBill) {
    lcdMsg("Cart Rs", String(total).c_str());
  }
}

// ============================
// WIFI
// ============================
void setup_wifi() {
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) delay(500);
}

// ============================
// MQTT CALLBACK
// ============================
void callback(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];

  if (String(topic) == "shop/total") {
    total = msg.toInt();
    showTotal();
  }

  else if (String(topic) == "shop/bill") {
    showingBill = true;
    lcdMsg("FINAL BILL", ("Rs " + msg).c_str());
    delay(5000);
    lcdMsg("THANK YOU!", "");
    delay(3000);
    total       = 0;
    showingBill = false;
    showIdle();
  }

  else if (String(topic) == "shop/theft") {
    lcdMsg("!! THEFT !!", "ALERT");
    delay(5000);
    showTotal();
  }
}

// ============================
// MQTT RECONNECT
// ============================
void reconnect() {
  while (!client.connected()) {
    if (client.connect("CART_NODE", mqtt_username, mqtt_password)) {
      client.subscribe("shop/total");
      client.subscribe("shop/bill");
      client.subscribe("shop/theft");
    } else {
      delay(2000);
    }
  }
}

// ============================
// SETUP
// ============================
void setup() {
  Serial.begin(115200);
  Wire.begin(6, 7);
  lcd.init();
  lcd.backlight();
  showIdle();
  setup_wifi();
  espClient.setInsecure();
  client.setServer(mqtt_server, 8883);
  client.setCallback(callback);
}

// ============================
// LOOP
// ============================
void loop() {
  if (!client.connected()) reconnect();
  client.loop();

  int basketValue = analogRead(BASKET_FS);

  // Only publish when value has meaningfully changed — avoids flooding shop node
  if (abs(basketValue - prevBasketSent) > 20) {
    client.publish("cart/basket", String(basketValue).c_str());
    prevBasketSent = basketValue;
  }

  delay(150);
}