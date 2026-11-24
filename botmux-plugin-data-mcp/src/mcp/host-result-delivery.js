import { DirectReplyError, assertOutboundFile, prepareCardText } from './direct-lark-reply.js';
const CAPABILITY = 'result_delivery_receipt_only_v1';

/** Old unprotected bots retain their current delivery contract. Receipt-only
 * bots must fail before reading data when the host cannot enforce the policy. */
export function useProtectedHostDelivery(caller, policy = '') {
  if (policy && !['legacy', 'receipt-only'].includes(policy)) throw new DirectReplyError('invalid_result_delivery_policy');
  const available = Array.isArray(caller?.hostCapabilities) && caller.hostCapabilities.includes(CAPABILITY);
  if (policy === 'receipt-only' && !available) throw new DirectReplyError('protected_result_host_required');
  return available && policy !== 'legacy';
}

export function prepareHostResultDelivery(caller, delivery, pluginHome) {
  if (caller?.source !== 'gateway_meta' || caller?.senderType !== 'user' || caller.callerSource || caller.taskId
    || !/^cli_[A-Za-z0-9_-]{3,200}$/.test(caller.requestLarkAppId || '')
    || !/^om_[A-Za-z0-9_-]{3,200}$/.test(caller.turnId || '')
    || typeof caller.requestUserUnionId !== 'string' || !caller.requestUserUnionId.startsWith('on_')
    || !useProtectedHostDelivery(caller, 'receipt-only')) throw new DirectReplyError('direct_reply_identity_rejected');
  if (!/^data-(?:result(?:-error)?|followup)-[a-f0-9-]{36}$/.test(delivery?.deliveryId || '')) throw new DirectReplyError('invalid_host_delivery_id');
  const files = (delivery.files || []).map(file => ({
    path: assertOutboundFile(file?.path, pluginHome),
    ...(typeof file?.name === 'string' ? { name: file.name } : {}),
  }));
  if (files.length > 6) throw new DirectReplyError('direct_reply_attachment_failed');
  const prepared = prepareCardText(typeof delivery.markdown === 'string' ? delivery.markdown.trim() : '');
  return {
    content: [{ type: 'text', text: JSON.stringify({ status: 'submitted', deliveryId: delivery.deliveryId }) }],
    _meta: { botmuxHostDelivery: {
      schemaVersion: 1, deliveryId: delivery.deliveryId, readPolicy: 'receipt-only',
      markdown: prepared.text || (files.length ? '查询结果文件见附件。' : '查询结果为空。'),
      ...(files.length ? { files } : {}),
      responseKind: delivery.responseKind === 'auxiliary' ? 'auxiliary' : 'final',
    } },
  };
}
