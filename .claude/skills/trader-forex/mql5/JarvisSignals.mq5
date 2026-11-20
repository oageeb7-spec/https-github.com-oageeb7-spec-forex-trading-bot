//+------------------------------------------------------------------+
//| JarvisSignals.mq5                                                 |
//| Shows the trader skills' results on any MT5 chart (STARTRADER or  |
//| any MT5 broker): the FX session clock, this symbol's forex or     |
//| stock scan result, and the trade plan's entry / stop / target as  |
//| lines, with an alert when the price reaches them.                 |
//|                                                                   |
//| Reads MQL5\Files\Common\jarvis_signals.txt, written by            |
//| .claude/skills/trader-forex/mt5bridge.py.                         |
//|                                                                   |
//| This is an INDICATOR: it cannot open, change or close a trade.    |
//| Sending stays manual (/fxsend in JARVIS with your typed yes, or   |
//| by hand in MT5). Education and tooling, not financial advice.     |
//+------------------------------------------------------------------+
#property copyright   "JARVIS trader skills"
#property version     "1.00"
#property description "Trader-skill signals and plan levels on the chart. Never trades."
#property indicator_chart_window
#property indicator_plots 0

input string InpFile        = "jarvis_signals.txt"; // File in the Common\Files folder
input int    InpRefreshSec  = 10;                   // Re-read the file every N seconds
input bool   InpShowPanel   = true;                 // Show the text panel (top left)
input bool   InpDrawLevels  = true;                 // Draw entry / stop / target lines
input bool   InpDrawRange   = true;                 // Draw the 20-day high / low (forex)
input bool   InpPopupAlert  = true;                 // Pop-up alert when a level is reached
input bool   InpPushAlert   = false;                // Push to the MT5 mobile app (Tools > Options > Notifications)
input int    InpStaleMin    = 1440;                 // Warn when the file is older than N minutes

#define PFX "JARVIS_"

// what the file says about this chart's symbol
string g_meta_updated = "", g_meta_sessions = "", g_meta_next = "", g_meta_ny = "";
bool   g_meta_open = false, g_file_ok = false;
string g_kind = "";         // "FX" or "STOCK" or ""
string g_scan_line = "";    // panel text for the scan row
double g_hi20 = 0, g_lo20 = 0;
bool   g_has_plan = false;
string g_side = "", g_size = "", g_unit = "", g_loss = "", g_rr = "", g_src = "", g_created = "";
double g_entry = 0, g_stop = 0, g_target = 0;
string g_plan_key = "";
// alert state (once per plan)
bool   g_hit_entry = false, g_hit_stop = false, g_hit_target = false;
double g_last_bid = 0;

//+------------------------------------------------------------------+
//| Chart symbol -> the name the skills use (EURUSD, XAUUSD, NVDA).   |
//| Handles broker suffixes and prefixes: EURUSD+, EURUSD.std,        |
//| #NVDA, NVDA.US, GOLD, SILVER.                                     |
//+------------------------------------------------------------------+
string Letters(string s)
  {
   string u = s;
   StringToUpper(u);
   string out = "";
   for(int i = 0; i < StringLen(u); i++)
     {
      ushort c = StringGetCharacter(u, i);
      if(c >= 'A' && c <= 'Z')
         out += ShortToString(c);
     }
   return out;
  }

bool IsCrypto()
  {
   string L = Letters(_Symbol);
   return (StringFind(L, "BTC") == 0 || StringFind(L, "XBT") == 0 || StringFind(L, "BITCOIN") == 0 ||
           StringFind(L, "ETH") == 0);
  }

bool Matches(string record_symbol)
  {
   string chart = Letters(_Symbol);
   string rec   = Letters(record_symbol);
   if(rec == "")
      return false;
   if(StringFind(chart, "GOLD") == 0)
      chart = "XAUUSD";
   if(StringFind(chart, "SILVER") == 0)
      chart = "XAGUSD";
   if(StringFind(chart, "BITCOIN") == 0 || StringFind(chart, "XBTUSD") == 0)
      chart = "BTCUSD";
   if(StringFind(chart, "ETHEREUM") == 0)
      chart = "ETHUSD";
   if(chart == rec)
      return true;
   // broker suffix: EURUSDM, EURUSDSTD, NVDAUS - the record must be the start
   // and the rest no longer than 3 letters, so NVDA does not match NVDAX-like names by chance
   if(StringFind(chart, rec) == 0 && StringLen(chart) - StringLen(rec) <= 3)
      return true;
   return false;
  }

//+------------------------------------------------------------------+
void ResetState()
  {
   g_meta_updated = ""; g_meta_sessions = ""; g_meta_next = ""; g_meta_ny = "";
   g_meta_open = false; g_kind = ""; g_scan_line = ""; g_hi20 = 0; g_lo20 = 0;
   g_has_plan = false; g_side = ""; g_size = ""; g_unit = ""; g_loss = ""; g_rr = "";
   g_src = ""; g_created = ""; g_entry = 0; g_stop = 0; g_target = 0;
  }

string Field(string &f[], int i)
  {
   return (i < ArraySize(f)) ? f[i] : "";
  }

string Readable(string semi)
  {
   string s = semi;
   StringReplace(s, ";", ", ");
   StringReplace(s, "_", " ");
   return (s == "") ? "no rule matched" : s;
  }

//+------------------------------------------------------------------+
//| Read the signals file                                             |
//+------------------------------------------------------------------+
void LoadFile()
  {
   string old_key = g_plan_key;
   ResetState();
   g_file_ok = false;
   int h = FileOpen(InpFile, FILE_READ | FILE_TXT | FILE_ANSI | FILE_COMMON | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE)
     {
      g_plan_key = "";
      return;
     }
   g_file_ok = true;
   while(!FileIsEnding(h))
     {
      string line = FileReadString(h);
      StringTrimLeft(line);
      StringTrimRight(line);
      if(line == "" || StringGetCharacter(line, 0) == '#')
         continue;
      string f[];
      int n = StringSplit(line, '|', f);
      if(n < 2)
         continue;
      string kind = f[0];
      if(kind == "META")
        {
         g_meta_updated  = Field(f, 1);
         g_meta_open     = (Field(f, 2) == "1");
         g_meta_sessions = Field(f, 3);
         g_meta_next     = Field(f, 4);
         g_meta_ny       = Field(f, 5);
        }
      else if(kind == "FX" && Matches(Field(f, 1)))
        {
         g_kind = "FX";
         g_hi20 = StringToDouble(Field(f, 6));
         g_lo20 = StringToDouble(Field(f, 7));
         g_scan_line = StringFormat("Scan (daily, %s): trend %s | RSI %s | ATR %s pips\n  %s",
                                    Field(f, 9), (Field(f, 3) == "" ? "-" : Field(f, 3)),
                                    (Field(f, 4) == "" ? "-" : Field(f, 4)),
                                    (Field(f, 5) == "" ? "-" : Field(f, 5)), Readable(Field(f, 8)));
        }
      else if(kind == "STOCK" && Matches(Field(f, 1)) && g_kind != "FX")
        {
         g_kind = "STOCK";
         g_scan_line = StringFormat("Stock scan (closes through %s): RSI %s\n  %s",
                                    Field(f, 5), (Field(f, 3) == "" ? "-" : Field(f, 3)), Readable(Field(f, 4)));
        }
      else if(kind == "PLAN" && Matches(Field(f, 1)) && !g_has_plan)
        {
         g_has_plan = true;
         g_side    = Field(f, 2);
         g_entry   = StringToDouble(Field(f, 3));
         g_stop    = StringToDouble(Field(f, 4));
         g_target  = StringToDouble(Field(f, 5));
         g_size    = Field(f, 6);
         g_unit    = Field(f, 7);
         g_loss    = Field(f, 8);
         g_rr      = Field(f, 9);
         g_src     = Field(f, 10);
         g_created = Field(f, 11);
        }
     }
   FileClose(h);

   g_plan_key = g_has_plan ? StringFormat("%s|%s|%.8f|%.8f|%.8f", g_created, g_side, g_entry, g_stop, g_target) : "";
   if(g_plan_key != old_key)
     {
      // a new or changed plan: alerts may ring again
      g_hit_entry = false; g_hit_stop = false; g_hit_target = false;
      g_last_bid = 0;
     }
  }

//+------------------------------------------------------------------+
//| Drawing                                                           |
//+------------------------------------------------------------------+
void HLine(string name, double price, color clr, ENUM_LINE_STYLE style, int width, string label)
  {
   string id = PFX + name;
   if(price <= 0)
     {
      ObjectDelete(0, id);
      return;
     }
   if(ObjectFind(0, id) < 0)
      ObjectCreate(0, id, OBJ_HLINE, 0, 0, price);
   ObjectSetDouble(0, id, OBJPROP_PRICE, price);
   ObjectSetInteger(0, id, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, id, OBJPROP_STYLE, style);
   ObjectSetInteger(0, id, OBJPROP_WIDTH, width);
   ObjectSetInteger(0, id, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, id, OBJPROP_BACK, true);
   ObjectSetString(0, id, OBJPROP_TEXT, label);
   ObjectSetString(0, id, OBJPROP_TOOLTIP, label + " " + DoubleToString(price, _Digits));
  }

void Draw()
  {
   bool lv = InpDrawLevels && g_has_plan;
   HLine("ENTRY",  lv ? g_entry  : 0, clrDodgerBlue, STYLE_DASH,  1, "JARVIS entry");
   HLine("STOP",   lv ? g_stop   : 0, clrRed,        STYLE_SOLID, 2, "JARVIS stop");
   HLine("TARGET", lv ? g_target : 0, clrLimeGreen,  STYLE_SOLID, 2, "JARVIS target");
   bool rg = InpDrawRange && g_kind == "FX";
   HLine("HI20", rg ? g_hi20 : 0, clrSilver, STYLE_DOT, 1, "20-day high");
   HLine("LO20", rg ? g_lo20 : 0, clrSilver, STYLE_DOT, 1, "20-day low");
   ChartRedraw();
  }

void Panel()
  {
   if(!InpShowPanel)
     {
      Comment("");
      return;
     }
   string t = "JARVIS signals - " + _Symbol + "  (indicator only: it never trades)\n";
   if(!g_file_ok)
     {
      t += "No signals file yet. On the PC run:\n  python .claude/skills/trader-forex/mt5bridge.py export --scan\n";
      Comment(t);
      return;
     }
   datetime upd = StringToTime(g_meta_updated);
   int age = (upd > 0) ? (int)((TimeGMT() - upd) / 60) : -1;
   t += StringFormat("Updated %s UTC (%s)%s\n", g_meta_updated,
                     (age < 0 ? "?" : (age < 120 ? IntegerToString(age) + " min ago" : IntegerToString(age / 60) + " h ago")),
                     (age > InpStaleMin ? "  STALE - re-run mt5bridge.py" : ""));
   if(IsCrypto())
      t += "Crypto trades 24/7 (weekends too). Spreads widen and gaps happen when it is quiet.\n";
   else if(g_meta_open)
      t += "FX open. Sessions: " + (g_meta_sessions == "" ? "between sessions (thin)" : g_meta_sessions) + "\n";
   else
      t += "FX closed. Opens " + g_meta_next + "\n";
   t += (g_scan_line == "" ? "Not in the latest scan." : g_scan_line) + "\n";
   if(g_has_plan)
     {
      string side = g_side;
      StringToUpper(side);
      t += StringFormat("Plan (%s): %s  entry %s  stop %s  target %s", g_src, side,
                        DoubleToString(g_entry, _Digits), DoubleToString(g_stop, _Digits),
                        DoubleToString(g_target, _Digits));
      if(g_rr != "")
         t += "  R:R " + g_rr;
      t += "\n";
      if(g_size != "")
         t += StringFormat("Size %s %s, loss at stop %s (before spread and swap)\n", g_size, g_unit, (g_loss == "" ? "?" : g_loss));
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      if(bid > 0 && g_entry > 0)
        {
         // pip sizes as in fx.py: JPY 0.01, gold 0.1, silver 0.01, other pairs 0.0001
         string L = Letters(_Symbol);
         double pt = _Point;
         if(g_kind == "FX")
           {
            if(StringFind(L, "BTC") == 0 || StringFind(L, "XBT") == 0 || StringFind(L, "BITCOIN") == 0)
               pt = 1.0;
            else if(StringFind(L, "ETH") == 0)
               pt = 0.1;
            else if(StringFind(L, "XAU") == 0 || StringFind(L, "GOLD") == 0)
               pt = 0.1;
            else if(StringFind(L, "XAG") == 0 || StringFind(L, "SILVER") == 0)
               pt = 0.01;
            else if(StringFind(L, "JPY") >= 0)
               pt = 0.01;
            else
               pt = 0.0001;
           }
         t += StringFormat("Bid %s, %.1f %s from the entry\n", DoubleToString(bid, _Digits),
                           MathAbs(bid - g_entry) / pt, (g_kind == "FX" ? "pips" : "points"));
        }
      if(g_hit_stop)   t += "STOP LEVEL REACHED\n";
      if(g_hit_target) t += "TARGET LEVEL REACHED\n";
     }
   else
      t += "No plan for this symbol.\n";
   t += "A scan match or plan is not a trade signal. Send orders yourself.";
   Comment(t);
  }

//+------------------------------------------------------------------+
//| Alerts: once per plan, on the bid crossing a level                |
//+------------------------------------------------------------------+
void Ring(string what, double level)
  {
   string msg = StringFormat("JARVIS %s: %s %s reached %s (plan %s %s)", _Symbol, what,
                             DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_BID), _Digits),
                             DoubleToString(level, _Digits), g_side, g_src);
   if(InpPopupAlert)
      Alert(msg);
   if(InpPushAlert)
      SendNotification(msg);
   Print(msg);
  }

void CheckAlerts()
  {
   if(!g_has_plan || g_entry <= 0)
      return;
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(bid <= 0)
      return;
   bool buy = (StringFind(g_side, "sell") < 0 && StringFind(g_side, "short") < 0);
   if(g_last_bid > 0)
     {
      if(!g_hit_entry && ((g_last_bid < g_entry && bid >= g_entry) || (g_last_bid > g_entry && bid <= g_entry)))
        {
         g_hit_entry = true;
         Ring("price at the ENTRY", g_entry);
        }
      if(!g_hit_stop && g_stop > 0 && (buy ? bid <= g_stop : bid >= g_stop))
        {
         g_hit_stop = true;
         Ring("price at the STOP", g_stop);
        }
      if(!g_hit_target && g_target > 0 && (buy ? bid >= g_target : bid <= g_target))
        {
         g_hit_target = true;
         Ring("price at the TARGET", g_target);
        }
     }
   g_last_bid = bid;
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   LoadFile();
   Draw();
   Panel();
   EventSetTimer(MathMax(1, InpRefreshSec));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   ObjectsDeleteAll(0, PFX);
   Comment("");
  }

void OnTimer()
  {
   LoadFile();
   Draw();
   CheckAlerts();
   Panel();
  }

int OnCalculate(const int rates_total, const int prev_calculated, const datetime &time[],
                const double &open[], const double &high[], const double &low[], const double &close[],
                const long &tick_volume[], const long &volume[], const int &spread[])
  {
   CheckAlerts();
   return rates_total;
  }
//+------------------------------------------------------------------+
