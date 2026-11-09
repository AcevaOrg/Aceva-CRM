"use client";
import * as React from "react";
import { Eye, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfidentialSeal } from "@/components/shared/confidential-seal";
import type { Confidentiality } from "@/types";

/** One profile section: title, who can see it, view mode and an inline edit mode. */
export function SectionCard({
  title,
  seal,
  visibleTo,
  canEdit,
  editing,
  onEdit,
  editLabel = "Edit",
  children,
  actions,
  viewOnly,
}: {
  title: string;
  seal?: Confidentiality;
  visibleTo: string;
  canEdit?: boolean;
  editing?: boolean;
  onEdit?: () => void;
  editLabel?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  /** Short note shown when the viewer can't edit, such as "View only. The Director edits." */
  viewOnly?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-wrap">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            {title} {seal && <ConfidentialSeal level={seal} compact />}
          </CardTitle>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Eye className="size-3.5" /> Visible to {visibleTo}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {!canEdit && viewOnly && <span className="text-[12px] text-muted-foreground">{viewOnly}</span>}
          {canEdit && !editing && (
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil /> {editLabel}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function FormActions({ onCancel, saving, label = "Save changes", note }: { onCancel: () => void; saving?: boolean; label?: string; note?: React.ReactNode }) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
      {note && <span className="mr-auto text-[12px] text-muted-foreground">{note}</span>}
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" loading={saving}>
        {label}
      </Button>
    </div>
  );
}
