import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Layout from "./components/layout";
import Dashboard from "./pages/dashboard";
import NewAnalysis from "./pages/new-analysis";
import Archives from "./pages/archives";
import AnalysisDetail from "./pages/analysis-detail";
import NewBriefing from "./pages/new-briefing";
import BriefingDetail from "./pages/briefing-detail";
import BriefingsArchives from "./pages/briefings-archives";
import SynergieExplorer from "./pages/synergie-explorer";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/new" component={NewAnalysis} />
        <Route path="/archives" component={Archives} />
        <Route path="/analyses/:id" component={AnalysisDetail} />
        <Route path="/briefings/new" component={NewBriefing} />
        <Route path="/briefings/archives" component={BriefingsArchives} />
        <Route path="/briefings/:id" component={BriefingDetail} />
        <Route path="/synergie/explorer" component={SynergieExplorer} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
