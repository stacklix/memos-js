import { cn } from "@/lib/utils";
import type { Attachment } from "@/types/proto/api/v1/attachment_service_pb";
import MemoAttachment from "./MemoAttachment";

interface Props {
  attachments: Attachment[];
  className?: string;
}

/**
 * MemoResource renders a list of memo attachments (resources).
 * Each attachment is displayed using the MemoAttachment component.
 */
const MemoResource: React.FC<Props> = ({ attachments, className }: Props) => {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  return (
    <div className={cn("w-full flex flex-row flex-wrap gap-1", className)}>
      {attachments.map((attachment) => (
        <MemoAttachment key={attachment.name} attachment={attachment} />
      ))}
    </div>
  );
};

export default MemoResource;
