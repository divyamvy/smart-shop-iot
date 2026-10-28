 
// SHOP NODE
 

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

 
// WIFI
 
const char* ssid     = "Piyush";
const char* password = "112233445566";

 
// HIVEMQ CLOUD
 
const char* mqtt_server   = "fa5e66fc548146f783420bef085c1154.s1.eu.hivemq.cloud";
const char* mqtt_username = "smartshop";
const char* mqtt_password = "Smartshop123";

 
// HARDWARE
 
WiFiClientSecure  espClient;
PubSubClient      client(espClient);
LiquidCrystal_I2C lcd(0x27, 16, 2);

#define TRIG1    4
#define ECHO1    5
#define TRIG2    17
#define ECHO2    16
#define RACK1_FS 0
#define RACK2_FS 1
#define BUZZER   20

 
// THRESHOLDS & TIMINGS
 
#define FS_THRESHOLD       300
#define PRESENCE_DIST      15
#define EXIT_TIMEOUT       5000
#define BASKET_COOLDOWN    2000
#define RACK_COOLDOWN      2000
#define THEFT_ABSENT_COUNT 33

 
// STATE
 
enum State { IDLE, RACK_PICKED, BASKET_PICKED };
State state = IDLE;

int  pickedRack      = 0;
int  pendingPrice    = 0;

int  total               = 0;
int  currentBasketValue  = 0;

int  prevRack1Value  = 0;
int  prevRack2Value  = 0;
int  prevBasketValue = 0;

bool customerSessionStarted  = false;
unsigned long lastPresenceMs = 0;
unsigned long stateEnteredMs = 0;

unsigned long lastBasketRiseMs = 0;
unsigned long lastRack1RiseMs  = 0;
unsigned long lastRack2RiseMs  = 0;

int absentCount = 0;

long duration;

 
// HELPERS
 
void lcdMsg(const char* line0, const char* line1 = "") {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line0);

  lcd.setCursor(0, 1);
  lcd.print(line1);
}

void showMainScreen() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("SMART SHOP");

  lcd.setCursor(0, 1);
  lcd.print("Total Rs");
  lcd.print(total);
}

void publishTotal() {
  client.publish("shop/total", String(total).c_str());
}

void syncPrev(int r1, int r2) {
  prevRack1Value  = r1;
  prevRack2Value  = r2;
  prevBasketValue = currentBasketValue;
}

void enterIdle() {
  state        = IDLE;
  pickedRack   = 0;
  pendingPrice = 0;
  absentCount  = 0;

  showMainScreen();
}

int getDistance(int trigPin, int echoPin) {

  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);

  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);

  digitalWrite(trigPin, LOW);

  duration = pulseIn(echoPin, HIGH, 30000);

  return duration * 0.034 / 2;
}

 
// WIFI
 
void setup_wifi() {

  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }
}

 
// MQTT
 
void callback(char* topic, byte* payload, unsigned int length) {

  String msg = "";

  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }

  if (String(topic) == "cart/basket") {
    currentBasketValue = msg.toInt();
  }
}

void reconnect() {

  while (!client.connected()) {

    if (client.connect("SHOP_NODE", mqtt_username, mqtt_password)) {

      client.subscribe("cart/basket");

    } else {

      delay(2000);
    }
  }
}

 
// SETUP
 
void setup() {

  Serial.begin(115200);

  Wire.begin(6, 7);

  lcd.init();
  lcd.backlight();

  pinMode(TRIG1, OUTPUT);
  pinMode(ECHO1, INPUT);

  pinMode(TRIG2, OUTPUT);
  pinMode(ECHO2, INPUT);

  pinMode(BUZZER, OUTPUT);

  // LOW trigger buzzer
  // HIGH = OFF
  digitalWrite(BUZZER, HIGH);

  prevRack1Value = analogRead(RACK1_FS);
  prevRack2Value = analogRead(RACK2_FS);

  setup_wifi();

  espClient.setInsecure();

  client.setServer(mqtt_server, 8883);
  client.setCallback(callback);

  showMainScreen();
}

 
// LOOP
 
void loop() {

  if (!client.connected()) {
    reconnect();
  }

  client.loop();

   
  // READ SENSORS
   

  int d1 = getDistance(TRIG1, ECHO1);
  delay(30);

  int d2 = getDistance(TRIG2, ECHO2);

  int rack1Value = analogRead(RACK1_FS);
  int rack2Value = analogRead(RACK2_FS);

   
  // PRESENCE
   

  bool userPresent =
    (d1 > 0 && d1 < PRESENCE_DIST) ||
    (d2 > 0 && d2 < PRESENCE_DIST);

  if (userPresent) {

    customerSessionStarted = true;

    lastPresenceMs = millis();

    absentCount = 0;
  }

   
  // RAW DELTAS
   

  int rack1Drop  = prevRack1Value  - rack1Value;
  int rack1Rise  = rack1Value      - prevRack1Value;

  int rack2Drop  = prevRack2Value  - rack2Value;
  int rack2Rise  = rack2Value      - prevRack2Value;

  int basketDrop = prevBasketValue - currentBasketValue;
  int basketRise = currentBasketValue - prevBasketValue;

   
  // COOLDOWN GATES
   

  bool basketDropAllowed =
    (millis() - lastBasketRiseMs > BASKET_COOLDOWN);

  bool rack1DropAllowed =
    (millis() - lastRack1RiseMs > RACK_COOLDOWN);

  bool rack2DropAllowed =
    (millis() - lastRack2RiseMs > RACK_COOLDOWN);

  // ==========================
  // STATE: IDLE
  // ==========================

  if (state == IDLE) {

     
    // SHOW RACK INFO
     

    if (d1 > 0 && d1 < PRESENCE_DIST) {

      lcdMsg("Rack1 Rs50",
             ("Cart Rs" + String(total)).c_str());
    }

    else if (d2 > 0 && d2 < PRESENCE_DIST) {

      lcdMsg("Rack2 Rs100",
             ("Cart Rs" + String(total)).c_str());
    }

     
    // PICK FROM RACK1
     

    if (rack1Drop > FS_THRESHOLD && rack1DropAllowed) {

      state          = RACK_PICKED;
      pickedRack     = 1;
      pendingPrice   = 50;
      stateEnteredMs = millis();

      absentCount = 0;

      lcdMsg("Item Picked",
             "Place In Cart");
    }

     
    // PICK FROM RACK2
     

    else if (rack2Drop > FS_THRESHOLD && rack2DropAllowed) {

      state          = RACK_PICKED;
      pickedRack     = 2;
      pendingPrice   = 100;
      stateEnteredMs = millis();

      absentCount = 0;

      lcdMsg("Item Picked",
             "Place In Cart");
    }

     
    // PICK FROM BASKET
     

    else if (basketDrop > FS_THRESHOLD && basketDropAllowed) {

      state          = BASKET_PICKED;
      stateEnteredMs = millis();

      absentCount = 0;

      lcdMsg("Taken From Cart",
             "Return To Rack?");
    }
  }

   ==========================
  // STATE: RACK_PICKED
   ==========================

  else if (state == RACK_PICKED) {

     
    // TRACK ABSENCE
     

    if (!userPresent) {
      absentCount++;
    } else {
      absentCount = 0;
    }

     
    // PLACED IN BASKET
     

    if (basketRise > FS_THRESHOLD) {

      total += pendingPrice;

      publishTotal();

      lcdMsg("Added To Cart",
             ("Rs " + String(total)).c_str());

      delay(2000);

      lastBasketRiseMs = millis();

      syncPrev(rack1Value, rack2Value);

      enterIdle();
    }

     
    // RETURNED TO RACK1
     

    else if (pickedRack == 1 &&
             rack1Rise > FS_THRESHOLD) {

      lcdMsg("Returned",
             "To Rack 1");

      delay(2000);

      lastRack1RiseMs = millis();

      syncPrev(rack1Value, rack2Value);

      enterIdle();
    }

     
    // RETURNED TO RACK2
     

    else if (pickedRack == 2 &&
             rack2Rise > FS_THRESHOLD) {

      lcdMsg("Returned",
             "To Rack 2");

      delay(2000);

      lastRack2RiseMs = millis();

      syncPrev(rack1Value, rack2Value);

      enterIdle();
    }

     
    // THEFT DETECTED
     

    else if (absentCount >= THEFT_ABSENT_COUNT) {

      lcdMsg("THEFT",
             "DETECTED");

      // BUZZER ON
      digitalWrite(BUZZER, LOW);

      client.publish("shop/theft",
                     "THEFT DETECTED");

      delay(5000);

      // BUZZER OFF
      digitalWrite(BUZZER, HIGH);

      syncPrev(rack1Value, rack2Value);

      enterIdle();
    }
  }

   ==========================
  // STATE: BASKET_PICKED
   ==========================

  else if (state == BASKET_PICKED) {

     
    // TRACK ABSENCE
     

    if (!userPresent) {
      absentCount++;
    } else {
      absentCount = 0;
    }

     
    // PUT BACK IN BASKET
     

    if (basketRise > FS_THRESHOLD) {

      lcdMsg("Back In Cart", "");

      delay(1500);

      lastBasketRiseMs = millis();

      syncPrev(rack1Value, rack2Value);

      enterIdle();
    }

     
    // RETURN TO RACK1
     

    else if (rack1Rise > FS_THRESHOLD) {

      total -= 50;

      if (total < 0) {
        total = 0;
      }

      publishTotal();

      lcdMsg("Returned Rack1",
             ("Rs " + String(total)).c_str());

      delay(2000);

      lastRack1RiseMs = millis();

      syncPrev(rack1Value, rack2Value);

      enterIdle();
    }

     
    // RETURN TO RACK2
     

    else if (rack2Rise > FS_THRESHOLD) {

      total -= 100;

      if (total < 0) {
        total = 0;
      }

      publishTotal();

      lcdMsg("Returned Rack2",
             ("Rs " + String(total)).c_str());

      delay(2000);

      lastRack2RiseMs = millis();

      syncPrev(rack1Value, rack2Value);

      enterIdle();
    }

     
    // THEFT DETECTED
     

    else if (absentCount >= THEFT_ABSENT_COUNT) {

      lcdMsg("THEFT",
             "DETECTED");

      // BUZZER ON
      digitalWrite(BUZZER, LOW);

      client.publish("shop/theft",
                     "THEFT DETECTED");

      delay(5000);

      // BUZZER OFF
      digitalWrite(BUZZER, HIGH);

      syncPrev(rack1Value, rack2Value);

      enterIdle();
    }
  }

   ==========================
  // CUSTOMER EXIT
   ==========================

  if (state == IDLE &&
      customerSessionStarted &&
      !userPresent &&
      (millis() - lastPresenceMs > EXIT_TIMEOUT)) {

    client.publish("shop/bill",
                   String(total).c_str());

    lcdMsg("Customer Exit",
           ("Bill Rs" + String(total)).c_str());

    delay(5000);

    total = 0;

    customerSessionStarted = false;

    lastBasketRiseMs = millis();
    lastRack1RiseMs  = millis();
    lastRack2RiseMs  = millis();

    prevRack1Value = analogRead(RACK1_FS);
    prevRack2Value = analogRead(RACK2_FS);

    prevBasketValue = currentBasketValue;

    showMainScreen();
  }

   
  // UPDATE PREV VALUES
   

  prevRack1Value  = rack1Value;
  prevRack2Value  = rack2Value;
  prevBasketValue = currentBasketValue;

  delay(150);
}