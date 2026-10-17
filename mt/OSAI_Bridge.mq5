//+------------------------------------------------------------------+
//| OSAI_Bridge.mq5 — executes OS AI live-strategy orders on MT5     |
//|                                                                  |
//| Setup: Tools > Options > Expert Advisors > tick "Allow WebRequest|
//| for listed URL" and add your OS AI address (ServerURL below).    |
//| Attach to ONE chart, enable Algo Trading, set Token to the       |
//| server's BRIDGE_TOKEN. Test on a DEMO account first.             |
//+------------------------------------------------------------------+
#property copyright "OS Trading AI"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

input string ServerURL     = "https://app.ostradingai.com"; // OS AI address (no trailing slash)
input string Token         = "";                            // BRIDGE_TOKEN from the server
input string SymbolSuffix  = "";                            // broker suffix, e.g. ".m" or "pro"
input string GoldSymbol    = "XAUUSD";                      // broker name for gold
input string BitcoinSymbol = "BTCUSD";                      // broker name for bitcoin
input long   Magic         = 7712001;                       // marks OS AI trades
input int    PollSeconds   = 5;                             // how often to check for orders
input double MaxLotsPerTrade = 0.10;                        // hard cap, whatever the server sends
input int    SlippagePoints  = 30;

CTrade trade;
long   lastSeq = 0;
string gvName;

int OnInit()
{
   if(Token == "") { Alert("OS AI: set the Token input to the server's BRIDGE_TOKEN"); return INIT_PARAMETERS_INCORRECT; }
   trade.SetExpertMagicNumber(Magic);
   trade.SetDeviationInPoints(SlippagePoints);
   gvName = "OSAI_lastSeq_" + IntegerToString(Magic);
   if(GlobalVariableCheck(gvName)) lastSeq = (long)GlobalVariableGet(gvName);
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
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double minL = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   lots = MathMin(lots, MaxLotsPerTrade);
   if(step > 0) lots = MathFloor(lots / step) * step;
   return MathMax(minL, MathMin(maxL, lots));
}

bool IsOurs(const ulong ticket, const string strategyId)
{
   if(!PositionSelectByTicket(ticket)) return false;
   if(PositionGetInteger(POSITION_MAGIC) != Magic) return false;
   return strategyId == "" || PositionGetString(POSITION_COMMENT) == "OSAI:" + strategyId;
}

string ClosePositions(const long seq, const string strategyId)
{
   string out = "";
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(!IsOurs(ticket, strategyId)) continue;
      if(trade.PositionClose(ticket))
         out += StringFormat("FILL|%I64d|%I64u|%s\n", seq, ticket, DoubleToString(trade.ResultPrice(), 8));
      else
         out += StringFormat("REJECT|%I64d|%u|%s\n", seq, trade.ResultRetcode(), trade.ResultRetcodeDescription());
   }
   return out;
}

string Execute(const string line)
{
   string f[];
   int n = StringSplit(line, '|', f);
   if(n < 2) return "";
   long seq = StringToInteger(f[0]);
   string action = f[1];
   string out = "";

   if(action == "open" && n >= 8)
   {
      string id = f[2], sym = BrokerSymbol(f[3]);
      bool buy = (f[4] == "buy");
      double sl = StringToDouble(f[6]), tp = StringToDouble(f[7]);
      if(!SymbolSelect(sym, true)) return StringFormat("REJECT|%I64d|0|unknown symbol %s\n", seq, sym);
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      sl = sl > 0 ? NormalizeDouble(sl, digits) : 0;
      tp = tp > 0 ? NormalizeDouble(tp, digits) : 0;
      double lots = NormalizeLots(sym, StringToDouble(f[5]));
      bool ok = buy ? trade.Buy(lots, sym, 0, sl, tp, "OSAI:" + id) : trade.Sell(lots, sym, 0, sl, tp, "OSAI:" + id);
      if(ok && (trade.ResultRetcode() == TRADE_RETCODE_DONE || trade.ResultRetcode() == TRADE_RETCODE_PLACED))
         out = StringFormat("FILL|%I64d|%I64u|%s\n", seq, trade.ResultOrder(), DoubleToString(trade.ResultPrice(), digits));
      else
         out = StringFormat("REJECT|%I64d|%u|%s\n", seq, trade.ResultRetcode(), trade.ResultRetcodeDescription());
   }
   else if(action == "close" && n >= 3) out = ClosePositions(seq, f[2]);
   else if(action == "close_all")       out = ClosePositions(seq, "");

   if(seq > lastSeq) { lastSeq = seq; GlobalVariableSet(gvName, (double)lastSeq); }
   return out;
}

string Snapshot()
{
   string out = StringFormat("ACCOUNT|%I64d|%s|%s|%.2f|%.2f\n",
      AccountInfoInteger(ACCOUNT_LOGIN), AccountInfoString(ACCOUNT_SERVER), AccountInfoString(ACCOUNT_CURRENCY),
      AccountInfoDouble(ACCOUNT_BALANCE), AccountInfoDouble(ACCOUNT_EQUITY));
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(!IsOurs(ticket, "")) continue;
      string comment = PositionGetString(POSITION_COMMENT);
      string id = StringSubstr(comment, 5); // after "OSAI:"
      out += StringFormat("POS|%s|%I64u|%s|%s|%.2f|%s|%.2f\n", id, ticket, PositionGetString(POSITION_SYMBOL),
         PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "buy" : "sell", PositionGetDouble(POSITION_VOLUME),
         DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 8), PositionGetDouble(POSITION_PROFIT));
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
      StringTrimLeft(line); StringTrimRight(line);
      if(StringLen(line) > 0) report += Execute(line);
   }
   report += Snapshot();
   Http("POST", "/api/bridge/report", report, status);
}
