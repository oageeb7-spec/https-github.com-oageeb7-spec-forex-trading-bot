//+------------------------------------------------------------------+
//| OSAI_Bridge.mq4 — executes OS AI live-strategy orders on MT4     |
//|                                                                  |
//| Setup: Tools > Options > Expert Advisors > tick "Allow WebRequest|
//| for listed URL" and add your OS AI address (ServerURL below).    |
//| Attach to ONE chart, enable AutoTrading, set Token to the        |
//| server's BRIDGE_TOKEN. Test on a DEMO account first.             |
//+------------------------------------------------------------------+
#property copyright "OS Trading AI"
#property version   "1.00"
#property strict

input string ServerURL     = "https://app.ostradingai.com"; // OS AI address (no trailing slash)
input string Token         = "";                            // BRIDGE_TOKEN from the server
input string SymbolSuffix  = "";                            // broker suffix, e.g. ".m" or "pro"
input string GoldSymbol    = "XAUUSD";                      // broker name for gold
input string BitcoinSymbol = "BTCUSD";                      // broker name for bitcoin
input int    Magic         = 7712001;                       // marks OS AI trades
input int    PollSeconds   = 5;                             // how often to check for orders
input double MaxLotsPerTrade = 0.10;                        // hard cap, whatever the server sends
input int    SlippagePoints  = 30;

int    lastSeq = 0;
string gvName;

int OnInit()
{
   if(Token == "") { Alert("OS AI: set the Token input to the server's BRIDGE_TOKEN"); return INIT_PARAMETERS_INCORRECT; }
   gvName = "OSAI_lastSeq_" + IntegerToString(Magic);
   if(GlobalVariableCheck(gvName)) lastSeq = (int)GlobalVariableGet(gvName);
   EventSetTimer(MathMax(PollSeconds, 2));
   Print("OS AI bridge started. Last order seen: ", lastSeq);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

string Http(const string method, const string path, const string body, int &status)
{
   char data[], result[];
   string respHeaders;
   string headers = "X-OSAI-Token: " + Token + "\r\nContent-Type: text/plain\r\n";
   if(StringLen(body) > 0)
   {
      StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
      ArrayResize(data, ArraySize(data) - 1); // drop the trailing \0
   }
   ResetLastError();
   status = WebRequest(method, ServerURL + path, headers, 10000, data, result, respHeaders);
   if(status == -1)
   {
      PrintFormat("OS AI: WebRequest failed (error %d). Add %s under Tools > Options > Expert Advisors > Allow WebRequest.", GetLastError(), ServerURL);
      return "";
   }
   return CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
}

string BrokerSymbol(const string s)
{
   if(s == "XAUUSD") return GoldSymbol;
   if(s == "BTCUSD") return BitcoinSymbol;
   return s + SymbolSuffix;
}

double NormalizeLots(const string sym, double lots)
{
   double step = MarketInfo(sym, MODE_LOTSTEP);
   double minL = MarketInfo(sym, MODE_MINLOT);
   double maxL = MarketInfo(sym, MODE_MAXLOT);
   lots = MathMin(lots, MaxLotsPerTrade);
   if(step > 0) lots = MathFloor(lots / step) * step;
   return MathMax(minL, MathMin(maxL, lots));
}

string ClosePositions(const int seq, const string strategyId)
{
   string out = "";
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if(OrderMagicNumber() != Magic || OrderType() > OP_SELL) continue;
      if(strategyId != "" && OrderComment() != "OSAI:" + strategyId) continue;
      string sym = OrderSymbol();
      RefreshRates();
      double price = OrderType() == OP_BUY ? MarketInfo(sym, MODE_BID) : MarketInfo(sym, MODE_ASK);
      int ticket = OrderTicket();
      if(OrderClose(ticket, OrderLots(), price, SlippagePoints, clrNONE))
         out += StringFormat("FILL|%d|%d|%s\n", seq, ticket, DoubleToString(price, (int)MarketInfo(sym, MODE_DIGITS)));
      else
         out += StringFormat("REJECT|%d|%d|close failed\n", seq, GetLastError());
   }
   return out;
}

string Execute(const string line)
{
   string f[];
   int n = StringSplit(line, '|', f);
   if(n < 2) return "";
   int seq = (int)StringToInteger(f[0]);
   string action = f[1];
   string out = "";

   if(action == "open" && n >= 8)
   {
      string id = f[2], sym = BrokerSymbol(f[3]);
      bool buy = (f[4] == "buy");
      if(!SymbolSelect(sym, true)) return StringFormat("REJECT|%d|0|unknown symbol %s\n", seq, sym);
      int digits = (int)MarketInfo(sym, MODE_DIGITS);
      double sl = StringToDouble(f[6]), tp = StringToDouble(f[7]);
      sl = sl > 0 ? NormalizeDouble(sl, digits) : 0;
      tp = tp > 0 ? NormalizeDouble(tp, digits) : 0;
      double lots = NormalizeLots(sym, StringToDouble(f[5]));
      RefreshRates();
      double price = buy ? MarketInfo(sym, MODE_ASK) : MarketInfo(sym, MODE_BID);
      int ticket = OrderSend(sym, buy ? OP_BUY : OP_SELL, lots, price, SlippagePoints, sl, tp, "OSAI:" + id, Magic, 0, clrNONE);
      if(ticket > 0) out = StringFormat("FILL|%d|%d|%s\n", seq, ticket, DoubleToString(price, digits));
      else           out = StringFormat("REJECT|%d|%d|OrderSend failed\n", seq, GetLastError());
   }
   else if(action == "close" && n >= 3) out = ClosePositions(seq, f[2]);
   else if(action == "close_all")       out = ClosePositions(seq, "");

   if(seq > lastSeq) { lastSeq = seq; GlobalVariableSet(gvName, lastSeq); }
   return out;
}

string Snapshot()
{
   string out = StringFormat("ACCOUNT|%d|%s|%s|%.2f|%.2f\n", AccountNumber(), AccountServer(), AccountCurrency(), AccountBalance(), AccountEquity());
   int count = 0;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if(OrderMagicNumber() != Magic || OrderType() > OP_SELL) continue;
      string id = StringSubstr(OrderComment(), 5); // after "OSAI:"
      out += StringFormat("POS|%s|%d|%s|%s|%.2f|%s|%.2f\n", id, OrderTicket(), OrderSymbol(), OrderType() == OP_BUY ? "buy" : "sell",
         OrderLots(), DoubleToString(OrderOpenPrice(), 8), OrderProfit() + OrderSwap() + OrderCommission());
      count++;
   }
   if(count == 0) out += "NOPOS\n";
   return out;
}

void OnTimer()
{
   int status;
   string orders = Http("GET", "/api/bridge/orders?after=" + IntegerToString(lastSeq), "", status);
   if(status != 200)
   {
      if(status > 0) PrintFormat("OS AI: server answered %d: %s", status, orders);
      return;
   }
   string report = "";
   string lines[];
   int n = StringSplit(orders, '\n', lines);
   for(int i = 0; i < n; i++)
   {
      string line = lines[i];
      line = StringTrimLeft(StringTrimRight(line));
      if(StringLen(line) > 0) report += Execute(line);
   }
   report += Snapshot();
   Http("POST", "/api/bridge/report", report, status);
}
