import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-5" aria-label="Loading Invook">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <Skeleton className="size-10 rounded-lg" />
          <Skeleton className="mt-3 h-6 w-52" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    </main>
  );
}
