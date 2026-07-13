import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import {
  deletePackagingPhoto,
  fetchPackagingPhotoUrl,
  listPackagingPhotos,
  type PackagingPhoto,
} from '@/lib/api'
import { cn } from '@/lib/utils'

interface PackagingImagesListProps {
  parentSampleId: string
  onEdit?: (photo: PackagingPhoto) => void
}

// Resolves the packaging photo's Bearer-gated bytes to an object URL. Fetched
// through react-query (not a photoId-keyed effect) because a retake PATCHes
// the SAME id — only the ['packaging-photo-bytes', id] invalidation the save
// path issues makes the on-screen thumbnail refresh.
function PackagingThumb({ photoId }: { photoId: number }) {
  const { data: url } = useQuery({
    queryKey: ['packaging-photo-bytes', photoId],
    queryFn: () => fetchPackagingPhotoUrl(photoId),
  })

  return (
    <div className="w-9 h-9 rounded bg-muted/60 border shrink-0 overflow-hidden flex items-center justify-center">
      {url ? (
        <img src={url} alt="" className="w-full h-full object-cover" />
      ) : (
        <span className="text-[8px] text-muted-foreground">no photo</span>
      )}
    </div>
  )
}

export function PackagingImagesList({
  parentSampleId,
  onEdit,
}: PackagingImagesListProps) {
  const queryClient = useQueryClient()

  // Polls while the packaging tab is mounted so photos landed by a phone
  // capture (Task 7's QR flow) show up here within seconds, without the tech
  // needing to switch tabs and back to trigger a refetch.
  const { data: photos = [] } = useQuery({
    queryKey: ['packaging-photos', parentSampleId],
    queryFn: () => listPackagingPhotos(parentSampleId),
    refetchInterval: 2500,
  })

  const deleteMutation = useMutation({
    mutationFn: (photoId: number) => deletePackagingPhoto(photoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['packaging-photos', parentSampleId],
      })
    },
  })

  return (
    <aside className="border-l bg-muted/20 p-3 overflow-y-auto h-full flex flex-col">
      <h3 className="text-sm font-semibold mb-2 uppercase tracking-wide text-muted-foreground">
        Packaging Images
      </h3>

      <ul className="space-y-1 flex-1">
        {photos.length === 0 && (
          <li className="text-xs text-muted-foreground px-2 py-1">
            No packaging images yet.
          </li>
        )}
        {photos.map(photo => (
          <li key={photo.id} className="rounded overflow-hidden">
            <div
              className={cn(
                'w-full p-2 rounded transition-colors flex items-center gap-2',
                'hover:bg-muted'
              )}
            >
              <button
                type="button"
                onClick={() => onEdit?.(photo)}
                title="Edit this packaging image — retake photo or edit remarks"
                className="min-w-0 flex-1 flex items-center gap-2 text-left"
              >
                <PackagingThumb photoId={photo.id} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground truncate">
                    {photo.remarks || 'No remarks'}
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => deleteMutation.mutate(photo.id)}
                disabled={deleteMutation.isPending}
                title="Delete this packaging image"
                aria-label="Delete packaging image"
                className="shrink-0 p-1 rounded text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  )
}
