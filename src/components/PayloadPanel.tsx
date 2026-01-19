import { X, FileJson, User, Package, FlaskConical, DollarSign, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface PayloadPanelProps {
  payload: Record<string, unknown> | null
  orderId: string
  onClose: () => void
}

/**
 * Renders a labeled field with proper formatting.
 */
function Field({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === '') return null
  
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <span className="text-sm">
        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
      </span>
    </div>
  )
}


/**
 * Panel for displaying order payload data in a friendly format.
 */
export function PayloadPanel({ payload, orderId, onClose }: PayloadPanelProps) {
  if (!payload) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No payload data available
      </div>
    )
  }

  // Extract common sections from the payload
  const billing = payload.billing as Record<string, unknown> | undefined
  const coaInfo = payload.coa_info as Record<string, unknown> | undefined
  const samples = payload.samples as Array<Record<string, unknown>> | undefined
  const services = payload.services as Record<string, unknown> | undefined
  const prices = payload.prices as Record<string, unknown> | undefined

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-2">
          <FileJson className="h-5 w-5 text-primary" />
          <div>
            <h2 className="font-semibold">Order Payload</h2>
            <p className="text-xs text-muted-foreground">Order #{orderId}</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {/* Billing Information */}
          {billing && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Billing Information
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm">
                <Field label="Company" value={billing.company} />
                <Field label="Name" value={`${billing.first_name || ''} ${billing.last_name || ''}`} />
                <Field label="Email" value={billing.email} />
                <Field label="Phone" value={billing.phone} />
                <div className="col-span-2">
                  <Field 
                    label="Address" 
                    value={[
                      billing.address_1,
                      billing.address_2,
                      `${billing.city || ''}, ${billing.state || ''} ${billing.postcode || ''}`,
                      billing.country
                    ].filter(Boolean).join('\n')} 
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* COA Information */}
          {coaInfo && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <MapPin className="h-4 w-4" />
                  COA Information
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm">
                <Field label="Brand Name" value={coaInfo.brand_name} />
                <Field label="Email" value={coaInfo.email} />
                <Field label="Website" value={coaInfo.website} />
                <Field label="Lot Number" value={coaInfo.lot_number} />
              </CardContent>
            </Card>
          )}

          {/* Samples */}
          {samples && samples.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FlaskConical className="h-4 w-4" />
                  Samples ({samples.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {samples.map((sample, index) => (
                  <div key={index} className="p-3 rounded-lg bg-muted/50 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">
                        {String(sample.peptide_name || sample.blend_name || `Sample ${index + 1}`)}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {String(sample.sample_type || 'Unknown')}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <Field label="Declared Qty" value={sample.declared_qty} />
                      <Field label="Lot" value={sample.lot} />
                      {sample.blend_peptides !== undefined && sample.blend_peptides !== null && (
                        <div className="col-span-2">
                          <Field label="Blend Peptides" value={
                            Array.isArray(sample.blend_peptides) 
                              ? JSON.stringify(sample.blend_peptides)
                              : String(sample.blend_peptides)
                          } />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Services */}
          {services && Object.keys(services).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  Services
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(services).map(([key, value]) => (
                    value === true && (
                      <Badge key={key} variant="secondary">
                        {key.replace(/_/g, ' ')}
                      </Badge>
                    )
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Prices */}
          {prices && Object.keys(prices).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <DollarSign className="h-4 w-4" />
                  Pricing
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(prices).map(([key, value]) => (
                  <Field key={key} label={key.replace(/_/g, ' ')} value={`$${value}`} />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Raw JSON fallback for unknown fields */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileJson className="h-4 w-4" />
                Raw Payload
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto max-h-[300px] overflow-y-auto">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </div>
  )
}
